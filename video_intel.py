#!/usr/bin/env python3
"""QwickSignal Phase 2.5: video intelligence.

For an important story, find the one public news video that really covers it and attach it to the
story in feed.json. The engine never takes "the first search result": every candidate is scored
against the story, and only a strong match (relevance_score >= video_min_score, default 0.75) is
attached. Otherwise the story is marked "No verified video found".

    news story  ->  search query  ->  candidate videos  ->  relevance score  ->  best video (or none)

How it is used
    python pipeline.py videos       (pipeline.py calls enrich_feed() below)

Design rules
    * Official APIs only. Nothing is scraped, downloaded or re-hosted; the app plays the video with
      YouTube's own embedded player, or links to the original page.
    * The API key is read from the environment (YOUTUBE_API_KEY) and never written to any file or log.
    * A video problem can never break the news feed: every failure is caught in here.
    * Platforms are plug-ins. YouTube ships today; add another by writing a class with the same two
      methods (search, details) and listing it in PROVIDERS.
    * The story's importance, country and sector come from the SAME engine the app uses (app.js, run
      through video_classify.js), so the pipeline and the phone always agree.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import re
import shutil
import subprocess
import time
import unicodedata
from pathlib import Path

# ----------------------------------------------------------------------------- settings
# Every value can be overridden under "settings:" in sources.yml.
DEFAULTS = {
    "video_enabled": True,                      # master switch (it also needs YOUTUBE_API_KEY)
    "video_platforms": ["youtube"],             # searched in this order; the first good match wins
    "video_importance": ["Critical", "High"],   # add "Medium" to cover more stories (uses more API quota)
    "video_min_score": 0.75,                    # a video is attached only at or above this relevance (0 to 1)
    "video_weights": {                          # how the relevance score is made up (normalised to 100%)
        "event": 0.35,                          #   headline / event similarity
        "entity": 0.20,                         #   people, companies, institutions, figures
        "action": 0.15,                         #   what happened (raises, cuts, attack, ceasefire ...)
        "geo": 0.10,                            #   country / geography
        "recency": 0.10,                        #   published close to the story
        "source": 0.10,                         #   publisher quality
    },
    "video_max_age_hours": 36,                  # only stories newer than this get a video search
    "video_max_per_run": 8,                     # searches per 15-minute run (protects quota and run time)
    "video_max_attempts": 3,                    # tries per story before giving up
    "video_retry_minutes": 120,                 # wait between tries (videos often appear hours after the news)
    "video_lookback_hours": 24,                 # search window that starts this long before the story
    "video_min_seconds": 20,                    # ignore clips shorter than this (shorts, teasers)
    "video_max_seconds": 2700,                  # ignore videos longer than this (45 min: full shows)
    "video_max_results": 8,                     # candidates fetched per search
    "video_region_code": "IN",                  # viewer's country: videos blocked there are skipped
    "video_daily_unit_budget": 8000,            # YouTube gives 10,000 units a day; a search costs 100
    "video_time_budget_seconds": 120,           # stop searching after this long in one run
    "video_revalidate_hours": 6,                # how often attached videos are re-checked (deleted, private)
    "video_trusted_publishers": [],             # extra channel names to trust fully, e.g. ["Sansad TV"]
}

YT_API = "https://www.googleapis.com/youtube/v3"
COST_SEARCH, COST_DETAILS = 100, 1
IMP_RANK = {"Critical": 3, "High": 2, "Medium": 1, "Low": 0}


class VideoError(Exception):
    """Base class: anything that goes wrong while looking for a video."""


class AuthError(VideoError):
    """The API key is missing, invalid or not allowed. Stop for this run."""


class QuotaError(VideoError):
    """Daily quota or rate limit reached. Stop and try again later."""


class TemporaryError(VideoError):
    """Network trouble or a timeout. Skip this story for now."""


class EngineError(VideoError):
    """The Node bridge (video_classify.js) is missing or failed."""


# ----------------------------------------------------------------------------- small helpers
def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(d: dt.datetime) -> str:
    return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_dt(s) -> dt.datetime | None:
    if not s:
        return None
    if isinstance(s, dt.datetime):
        return s if s.tzinfo else s.replace(tzinfo=dt.timezone.utc)
    try:
        d = dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)


def redact(text, secrets=()) -> str:
    """Remove any API key from text before it is logged (error messages can contain the request URL)."""
    out = str(text)
    for s in secrets:
        if s:
            out = out.replace(s, "***")
    return re.sub(r"(key=)[A-Za-z0-9_\-]{12,}", r"\1***", out)


def fold(s: str) -> str:
    """Lower-case, accent-free text."""
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def duration_seconds(iso_dur: str) -> int:
    """'PT2M14S' -> 134"""
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso_dur or "")
    if not m:
        return 0
    d, h, mi, s = (int(x or 0) for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + s


def fmt_duration(sec: int) -> str:
    h, rem = divmod(int(sec), 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


# ----------------------------------------------------------------------------- text analysis
STOP = set(("the a an and or but if then of to in on at by for with from as is are was were be been being it its this that these those "
            "he she they we you i not no nor so than too very can will would could should may might must has have had do does did "
            "into over under about after before during between against per via also more most other such only own same just up down "
            "out off again here there when where why how all any both each few some what which who whom said says say new one two "
            "according reported reports report today yesterday tomorrow week month year years while amid however their them his her "
            "our your than then still even much many made make makes video watch live news latest breaking update updates full "
            "story explained analysis").split())

# Well-known abbreviations, matched in both directions: "BOJ" also counts as "Bank of Japan".
ALIASES = {
    "boj": "bank of japan", "rbi": "reserve bank of india", "ecb": "european central bank", "fed": "federal reserve",
    "boe": "bank of england", "pboc": "peoples bank of china", "imf": "international monetary fund", "un": "united nations",
    "eu": "european union", "uk": "united kingdom", "us": "united states", "usa": "united states", "uae": "united arab emirates",
    "opec": "organization of petroleum exporting countries", "sebi": "securities and exchange board of india",
    "wto": "world trade organization", "fbi": "federal bureau of investigation", "isro": "indian space research organisation",
    "nato": "north atlantic treaty organization", "tsmc": "taiwan semiconductor manufacturing company",
}

# Generic acronyms are ordinary words, not identifying names.
GENERIC_ACRONYMS = {"GDP", "CPI", "AI", "IPO", "CEO", "CFO", "ETF", "FDI", "PMI", "EV", "IT", "TV", "PM", "OK", "FY", "Q1", "Q2", "Q3", "Q4", "GST"}

NOT_ENTITY = set(("january february march april may june july august september october november december monday tuesday wednesday "
                  "thursday friday saturday sunday breaking update exclusive watch live video photos report reports reportedly "
                  "officials sources analysts authorities ministry minister president police army court company government "
                  "parliament according however meanwhile amid after before the a an in on at as how why what when who this that "
                  "these those new first second third russia's").split())

# What happened. Each group is one kind of event; words in the same group are treated as the same action.
ACTIONS = {
    "up": r"rais(?:e|es|ed|ing)|hik(?:e|es|ed|ing)|boost\w*|increas\w*|lift(?:s|ed|ing)?|jump\w*|surg\w*|soar\w*|ris(?:e|es|ing|en)|rose|"
          r"climb\w*|rall(?:y|ies|ied)|gain\w*|spik\w*|upgrad\w*|higher|record high",
    "down": r"cut(?:s|ting)?|lower\w*|slash\w*|reduc\w*|drop\w*|fall(?:s|ing|en)?|fell|plung\w*|plummet\w*|slump\w*|declin\w*|slid\w*|"
            r"tumbl\w*|eas(?:e|es|ed|ing)|shrink\w*|downgrad\w*|sink\w*|dip(?:s|ped)?|slow\w*|lowest",
    "hold": r"hold(?:s|ing)?|held|keep(?:s|ing)?|kept|maintain\w*|unchanged|steady|paus\w*|freez\w*",
    "attack": r"attack\w*|strik(?:e|es|ing)|struck|bomb\w*|shell(?:s|ed|ing)|raid\w*|assault\w*|drone\w*|missile\w*|explo\w+|blast\w*|airstrik\w*",
    "casualty": r"kill\w*|dead|death\w*|casualt\w*|toll|wound\w*|injur\w*|die[sd]?|perish\w*",
    "talks": r"talk(?:s|ing)?|negotiat\w*|summit\w*|agree\w*|agreement\w*|deal\w*|pact\w*|accord\w*|treat(?:y|ies)|ceasefire\w*|truce\w*|peace",
    "election": r"elect\w*|vote[sd]?|voting|poll(?:s|ing)?|ballot\w*|victor\w*|won|wins?|concede\w*|sworn|inaugurat\w*",
    "corporate": r"acqui\w*|merg\w*|buy(?:s|ing)?|bought|takeover\w*|bid(?:s|ding)?|stake\w*|invest\w*|partner\w*",
    "sanction": r"sanction\w*|ban(?:s|ned|ning)?|embargo\w*|tariff\w*|restrict\w*|curb\w*|block(?:s|ed|ing)?|blacklist\w*",
    "leadership": r"resign\w*|quit\w*|sack\w*|fire[sd]?|firing|dismiss\w*|appoint\w*|nominat\w*|replac\w*|step(?:s|ped)? down",
    "protest": r"protest\w*|riot\w*|unrest|clash\w*|demonstrat\w*",
    "disaster": r"earthquake\w*|flood\w*|storm\w*|cyclone\w*|hurricane\w*|wildfire\w*|tsunami\w*|landslide\w*|erupt\w*|typhoon\w*",
    "launch": r"launch\w*|unveil\w*|introduc\w*|releas\w*|debut\w*|inaugurat\w*",
    "legal": r"arrest\w*|detain\w*|charg(?:e|es|ed|ing)|indict\w*|convict\w*|sentenc\w*|jail\w*|verdict\w*|ruling|court",
    "collapse": r"collaps\w*|bankrupt\w*|default\w*|insolven\w*|shutdown|halt\w*|suspend\w*",
    "recall": r"recall\w*",
    "outage": r"outage\w*|blackout\w*|breach\w*|hack\w*|cyberattack\w*|ransomware",
    "warning": r"warn\w*|threat\w*",
    "results": r"earning\w*|profit\w*|revenue\w*|quarterly|guidance|forecast\w*",
    "accident": r"crash\w*|derail\w*|collid\w*|collision\w*",
    "evacuation": r"evacuat\w*|rescu\w*|trapped",
}
_ACTION_RX = {k: re.compile(r"\b(?:" + v + r")\b") for k, v in ACTIONS.items()}
OPPOSITE = (("up", "down"), ("up", "hold"), ("down", "hold"))

CLICKBAIT = re.compile(r"(!{2,}|\b(shocking|you won'?t believe|must watch|gone wrong|goes viral|exposed|leaked)\b)", re.I)
COMPILATION = re.compile(r"\b(top \d+|headlines|news today|live updates?|live blog|news bulletin|morning news|evening news|daily digest|"
                         r"news roundup|weekly roundup|watch live|livestream|live stream)\b", re.I)

# Publishers. Tier 1 = established news organisations (score 1.0). Tier 2 = mainstream but less strict (0.8). Unknown = 0.35.
TIER1 = ("reuters", "associated press", "bloomberg", "bbc", "al jazeera", "cnbc", "cnn", "dw news", "france 24", "sky news", "nhk",
         "wall street journal", "financial times", "guardian news", "pbs newshour", "abc news", "nbc news", "cbs news", "euronews",
         "trt world", "ndtv", "india today", "wion", "the hindu", "hindustan times", "times of india", "economic times", "livemint",
         "cnbctv18", "cnbc tv18", "ani news", "dd news", "business standard", "firstpost", "news18", "the economist", "afp",
         "channel 4 news", "cbc news", "global news", "the times of india")
TIER2 = ("times now", "republic world", "zee news", "abp news", "aaj tak", "the quint", "theprint", "the print", "moneycontrol",
         "ndtv profit", "et now", "newsx", "mirror now", "cnn-news18")

_YEARS = range(1900, 2101)
ENTITY_WEIGHTS = [1.0, 1.0, 0.6, 0.4, 0.3]


def stem(w: str) -> str:
    if w.endswith("'s"):
        w = w[:-2]
    if len(w) > 5:
        if w.endswith("ies"):
            w = w[:-3] + "y"
        elif w.endswith("ing"):
            w = w[:-3]
        elif w.endswith("ed"):
            w = w[:-2]
        elif w.endswith("es"):
            w = w[:-2]
    if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
        w = w[:-1]
    if len(w) > 4 and w.endswith("e"):
        w = w[:-1]
    return w


def norm_number(n: str) -> str:
    n = n.replace(",", "")
    if "." in n:
        n = n.rstrip("0").rstrip(".")
    return n


def expand_aliases(t: str) -> str:
    """Add the long form of an abbreviation (and the abbreviation of a long form) to folded text."""
    words = set(re.findall(r"[a-z]+", t))
    extra = []
    for ac, phrase in ALIASES.items():
        if ac in words:
            extra.append(phrase)
        elif phrase in t:
            extra.append(ac)
    return t + " " + " ".join(extra) if extra else t


def tokenize(text: str, expand: bool = True) -> list[str]:
    """Numbers and stemmed words, without filler. With expand=True, abbreviations also count as their long form
    (used on the video's text, so "BOJ" matches "Bank of Japan"). The story side uses expand=False so an entity is counted once."""
    t = expand_aliases(fold(text)) if expand else fold(text)
    out = []
    for m in re.findall(r"\d[\d,]*(?:\.\d+)?|[a-z]+(?:'[a-z]+)?", t):
        if m[0].isdigit():
            out.append(norm_number(m))
        else:
            s = stem(m)
            if len(s) > 2 and s not in STOP:
                out.append(s)
    return out


def find_actions(text: str) -> set[str]:
    t = fold(text)
    return {k for k, rx in _ACTION_RX.items() if rx.search(t)}


_ATTRIBUTION = re.compile(r",?\s+(?:according to|as per|citing|said|says|told|reported by|sources (?:said|say|told)|officials (?:said|say))\b", re.I)


def first_clause(headline: str, limit: int = 220) -> str:
    """The part of a (possibly very long) headline that states the event: the first sentence, without "according to ..." attribution."""
    h = re.sub(r"\s+", " ", (headline or "")).strip()
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])", h)
    first = parts[0] if parts and len(parts[0]) >= 25 else h
    m = _ATTRIBUTION.search(first)
    if m and m.start() >= 40:
        first = first[:m.start()]
    if len(first) > limit:
        first = first[:limit].rsplit(" ", 1)[0]
    return first.rstrip(" .")


_CAP_SEQ = re.compile(r"\b[A-Z][\w&'\u2019.-]*(?:\s+(?:of|the|de|del|for|&)\s+[A-Z][\w&'\u2019.-]*|\s+[A-Z][\w&'\u2019.-]*)*")


def extract_entities(focus: str, known: list[str], skip_singles: set[str]) -> list[str]:
    """Proper names in the headline (people, institutions, companies), best first."""
    text = re.sub(r"\b([A-Z])\.([A-Z])\.?", r"\1\2", focus)   # U.S. -> US
    found: list[tuple[int, int, str]] = []
    for m in _CAP_SEQ.finditer(text):
        ent = m.group(0).strip(" .,'-\u2019")
        words = ent.split()
        if not words:
            continue
        single = len(words) == 1
        if single:
            low = fold(ent)
            if low in NOT_ENTITY or ent in GENERIC_ACRONYMS or low in skip_singles or len(ent) < 3:
                continue
            if m.start() == 0 and not ent.isupper():        # capitalised only because it starts the sentence
                continue
        elif fold(words[0]) in NOT_ENTITY:
            ent = " ".join(words[1:])
            if not ent:
                continue
        found.append((0, m.start(), ent))
    for k in known:
        if k and all(fold(k) != fold(e[2]) for e in found):
            found.append((0, len(text), k))
    found.sort(key=lambda x: x[1])
    out: list[str] = []
    for _, _, e in found:
        if all(fold(e) != fold(o) for o in out):
            out.append(e)
    return out[:5]


def extract_numbers(focus: str) -> list[str]:
    nums = []
    for m in re.findall(r"\d[\d,]*(?:\.\d+)?", focus):
        n = norm_number(m)
        if "." not in n and (len(n) < 2 or (len(n) == 4 and int(n) in _YEARS)):
            continue
        if n not in nums:
            nums.append(n)
    return nums[:3]


def story_features(item: dict, analysis: dict) -> dict:
    """Everything the matcher needs to know about the story, taken from the headline and the app's own classification."""
    headline = item.get("headline") or ""
    focus = first_clause(headline)
    country = analysis.get("country") or item.get("country") or "Global"
    involved = list(analysis.get("involved") or item.get("involved") or [])
    companies = [c if isinstance(c, str) else (c or {}).get("name", "") for c in (analysis.get("companies") or item.get("companies") or [])]
    skip = {fold(country)} | {fold(c) for c in involved}
    entities = extract_entities(focus, [c for c in companies if c], skip)
    numbers = extract_numbers(focus)
    actions = find_actions(focus)

    weights: dict[str, float] = {}
    for t in tokenize(focus, expand=False):
        weights.setdefault(t, 1.0)
    for e in entities:
        for t in tokenize(e, expand=False):
            weights[t] = 2.0
    for n in numbers:
        weights[n] = 2.0
    for g in actions:                                   # the action is compared by kind, not by exact word
        for w in re.findall(r"[a-z]+", fold(focus)):
            if _ACTION_RX[g].fullmatch(w):
                weights.pop(stem(w), None)
        weights["@" + g] = 1.5
    kept, ordinary = {}, 0
    for t, w in weights.items():                        # insertion order = order of appearance in the headline
        if w == 1.0:
            ordinary += 1
            if ordinary > 8:
                continue
        kept[t] = w
    keep = sorted(kept.items(), key=lambda kv: -kv[1])[:14]
    return {
        "headline": headline, "focus": focus, "entities": entities, "numbers": numbers, "actions": actions,
        "weights": dict(keep), "all_tokens": set(tokenize(focus, expand=True)), "country": country, "involved": involved,
        "importance": analysis.get("importance") or item.get("importance") or "Low",
        "published": parse_dt(item.get("published")) or parse_dt(item.get("updated")),
    }


def build_query(feat: dict) -> str:
    """A short search phrase: names, the action, the figures, then the country. Example: 'Bank of Japan raises rates 1.25 news'."""
    focus = feat["focus"]
    words: list[str] = []

    def add(w: str) -> None:
        if w and fold(w) not in [fold(x) for x in words]:
            words.append(w)

    for e in feat["entities"][:3]:
        for w in e.split():
            add(w)
    raw = re.findall(r"[A-Za-z][A-Za-z'\u2019-]*|\d[\d,]*(?:\.\d+)?", focus)
    for w in raw:                                        # the action word as written
        if any(rx.fullmatch(fold(w)) for rx in _ACTION_RX.values()):
            add(w)
            break
    for n in feat["numbers"]:
        add(n)
    for w in raw:                                        # then remaining content words, in order
        if len(words) >= 9:
            break
        if fold(w) not in STOP and len(w) > 3:
            add(w)
    c = feat["country"]
    if c and c != "Global" and fold(c) not in fold(" ".join(words)):
        add(c)
    return " ".join(words[:10]) + " news"


# ----------------------------------------------------------------------------- scoring
def recency_score(video_dt: dt.datetime | None, story_dt: dt.datetime | None) -> float:
    """1.0 when the video came out within a few hours before to a day and a half after the story."""
    if not video_dt or not story_dt:
        return 0.5
    h = (video_dt - story_dt).total_seconds() / 3600
    if -3 <= h <= 36:
        return 1.0
    if h < -3:
        return max(0.0, 1 - (-3 - h) / 24)
    return max(0.0, 1 - (h - 36) / 96)


def publisher_tier(channel: str, extra=()) -> float:
    c = fold(channel)
    if any(fold(x) in c for x in extra if x):
        return 1.0
    if any(t in c for t in TIER1):
        return 1.0
    if any(t in c for t in TIER2):
        return 0.8
    return 0.35


def score_candidate(feat: dict, cand: dict, cls: dict, cfg: dict) -> dict:
    """Score one candidate video from 0 to 1 and say why it was rejected, if it was.

    cand: title, description, channel, published_at (datetime), duration_s, embeddable, live, public, region_ok
    cls : the app engine's read of the video's own text (country, involved)
    """
    reasons: list[str] = []
    title, desc, channel = cand.get("title", ""), (cand.get("description") or "")[:500], cand.get("channel", "")
    ttoks, dtoks = set(tokenize(title)), set(tokenize(desc))
    for text, bucket in ((title, ttoks), (desc, dtoks)):
        for g in find_actions(text):
            bucket.add("@" + g)

    # 1. headline / event similarity: how much of the story's key wording the video title (and description) carries
    weights = feat["weights"]
    total = sum(weights.values()) or 1.0
    covered = sum(w * (1.0 if t in ttoks else 0.6 if t in dtoks else 0.0) for t, w in weights.items())
    coverage = covered / total
    precision = len(ttoks & (feat["all_tokens"] | {t for t in weights if t.startswith("@")})) / max(1, len(ttoks))
    event = 0.75 * coverage + 0.25 * precision
    if COMPILATION.search(title):
        reasons.append("compilation")          # a mixed bulletin is not the video of this one story

    # 2. entities: the names and figures the story is about must appear in the video
    blob = expand_aliases(fold(title + " " + desc + " " + channel))
    btoks = set(tokenize(blob))
    ents = feat["entities"] + feat["numbers"]
    ent_w = ENTITY_WEIGHTS[:len(feat["entities"])] + [1.0] * len(feat["numbers"])   # early names are central, late ones incidental
    matched = 0.0
    for e, w in zip(ents, ent_w):
        et = tokenize(e, expand=False)
        if et and all(t in btoks for t in et):
            matched += w
    ent_frac = matched / sum(ent_w) if ents else None
    entity = ent_frac if ent_frac is not None else 0.5

    # 3. action: same kind of event; the opposite kind (raises vs cuts) is a contradiction
    v_act = find_actions(title + " " + desc[:200])
    s_act = feat["actions"]
    action = (len(s_act & v_act) / len(s_act)) if s_act else 0.5
    contradiction = any((a in s_act and b not in s_act and b in v_act and a not in v_act) or
                        (b in s_act and a not in s_act and a in v_act and b not in v_act) for a, b in OPPOSITE)

    # 4. geography
    S = {feat["country"]} - {"Global"}
    I = set(feat["involved"])
    T = S | I                                             # every country the story is about
    V = ({cls.get("country")} | set(cls.get("involved") or [])) - {"Global", None}
    if not T:
        geo = 0.7
    elif not V:
        geo = 0.5
    elif S & V or (not S and T & V):
        geo = 1.0
    elif I & V:
        geo = 0.6
    else:
        geo = 0.0

    # 5. recency, 6. publisher
    recency = recency_score(cand.get("published_at"), feat["published"])
    source = publisher_tier(channel, cfg.get("video_trusted_publishers") or ())
    trusted = source >= 0.8
    if CLICKBAIT.search(title) and not trusted:
        reasons.append("clickbait")
        source = 0.0

    w = cfg["video_weights"]
    wsum = sum(w.values()) or 1.0
    parts = {"event": event, "entity": entity, "action": action, "geo": geo, "recency": recency, "source": source}
    score = sum(w.get(k, 0) * v for k, v in parts.items()) / wsum

    # Hard gates: a high score can never rescue a video that is plainly about something else
    if len(ents) >= 2 and ent_frac is not None and ent_frac < 0.5:
        reasons.append("entities-missing")
    if len(ents) == 1 and ent_frac == 0:
        reasons.append("entities-missing")
    if contradiction:
        reasons.append("contradicts-action")
    if T and V and not (T & V):
        reasons.append("wrong-country")
    s_dec = {n for n in feat["numbers"] if "." in n}
    v_dec = {norm_number(n) for n in re.findall(r"\d[\d,]*\.\d+", title)}
    if s_dec and v_dec and not (s_dec & v_dec):
        reasons.append("figure-mismatch")       # the title quotes a different figure than the story
    pub, story = cand.get("published_at"), feat["published"]
    if pub and story and (pub - story).total_seconds() / 3600 < -float(cfg["video_lookback_hours"]) * 2:
        reasons.append("too-old")
    if not cand.get("public", True):
        reasons.append("not-public")
    if cand.get("live"):
        reasons.append("live-or-upcoming")
    if not cand.get("region_ok", True):
        reasons.append("region-blocked")
    dur = cand.get("duration_s") or 0
    if dur and (dur < int(cfg["video_min_seconds"]) or dur > int(cfg["video_max_seconds"])):
        reasons.append("duration")
    hard = list(reasons)
    return {"score": round(score, 4), "parts": {k: round(v, 3) for k, v in parts.items()}, "reject": hard[0] if hard else None, "reasons": reasons}


# ----------------------------------------------------------------------------- the app's own engine, through Node
class Engine:
    """Runs video_classify.js so the pipeline reads a story exactly like the app does."""

    def __init__(self, root: Path, runner=subprocess.run, timeout: int = 60):
        self.root, self.runner, self.timeout = Path(root), runner, timeout

    def available(self) -> bool:
        return bool(shutil.which("node")) and (self.root / "video_classify.js").exists() and (self.root / "app.js").exists()

    def classify(self, docs: list[dict]) -> dict[str, dict]:
        if not docs:
            return {}
        try:
            p = self.runner(["node", str(self.root / "video_classify.js")], input=json.dumps({"docs": docs}),
                            capture_output=True, text=True, timeout=self.timeout)
        except Exception as exc:  # noqa: BLE001
            raise EngineError(f"Node could not be started: {exc}") from exc
        if p.returncode != 0:
            raise EngineError(f"video_classify.js failed: {(p.stderr or '').strip()[:200]}")
        try:
            return json.loads(p.stdout or "{}")
        except ValueError as exc:
            raise EngineError("video_classify.js returned unreadable output") from exc


# ----------------------------------------------------------------------------- quota
class Budget:
    """Counts YouTube quota units per day and remembers a cool-down after a quota error. Lives in state.json."""

    def __init__(self, store: dict, limit: int, now: dt.datetime):
        self.s, self.limit, self.now = store, int(limit), now
        day = now.strftime("%Y-%m-%d")
        if self.s.get("day") != day:
            self.s["day"], self.s["units"] = day, 0

    @property
    def used(self) -> int:
        return int(self.s.get("units", 0))

    def blocked(self) -> bool:
        until = parse_dt(self.s.get("blocked_until"))
        return bool(until and until > self.now)

    def spend(self, units: int) -> None:
        if self.blocked():
            raise QuotaError("waiting after a quota error")
        if self.used + units > self.limit:
            raise QuotaError(f"daily budget of {self.limit} units reached")
        self.s["units"] = self.used + units

    def block(self, hours: float) -> None:
        self.s["blocked_until"] = iso(self.now + dt.timedelta(hours=hours))


# ----------------------------------------------------------------------------- platform: YouTube
class YouTubeProvider:
    """YouTube Data API v3 (official). One search costs 100 quota units, checking a batch of videos costs 1."""

    name = "youtube"

    def __init__(self, key: str, http, budget: Budget, region: str = "IN", timeout: int = 10):
        self.key, self.http, self.budget, self.region, self.timeout = key, http, budget, region, timeout

    def _get(self, path: str, params: dict, cost: int) -> dict:
        self.budget.spend(cost)
        try:
            r = self.http(f"{YT_API}/{path}", params={**params, "key": self.key}, timeout=self.timeout)
        except Exception as exc:  # noqa: BLE001  (timeouts, DNS, TLS ... any network trouble)
            raise TemporaryError(redact(exc, [self.key])) from None
        if r.status_code == 200:
            try:
                return r.json()
            except ValueError:
                raise TemporaryError("YouTube returned unreadable data") from None
        reason = ""
        try:
            reason = ((r.json().get("error") or {}).get("errors") or [{}])[0].get("reason", "")
        except Exception:  # noqa: BLE001
            pass
        if r.status_code == 429 or reason in ("quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded"):
            self.budget.block(8 if reason in ("quotaExceeded", "dailyLimitExceeded") else 1)
            raise QuotaError(f"YouTube quota or rate limit ({reason or r.status_code})")
        if r.status_code in (400, 401, 403) and (reason in ("keyInvalid", "badRequest", "accessNotConfigured", "forbidden", "ipRefererBlocked",
                                                            "API_KEY_INVALID", "API_KEY_HTTP_REFERRER_BLOCKED") or r.status_code in (401, 403)):
            raise AuthError(f"YouTube rejected the API key (HTTP {r.status_code} {reason})")
        raise TemporaryError(f"YouTube HTTP {r.status_code} {reason}".strip())

    def search(self, query: str, published_after: dt.datetime, max_results: int) -> list[str]:
        data = self._get("search", {"part": "snippet", "type": "video", "q": query, "maxResults": max_results, "order": "relevance",
                                     "publishedAfter": iso(published_after), "relevanceLanguage": "en", "safeSearch": "moderate",
                                     "regionCode": self.region}, COST_SEARCH)
        ids = []
        for it in data.get("items") or []:
            vid = ((it.get("id") or {}).get("videoId")) or ""
            if re.fullmatch(r"[A-Za-z0-9_-]{11}", vid) and vid not in ids:
                ids.append(vid)
        return ids

    def details(self, ids: list[str]) -> dict[str, dict]:
        """Facts that decide whether a video can really be shown: public, embeddable, not blocked, how long."""
        out: dict[str, dict] = {}
        for i in range(0, len(ids), 50):
            chunk = ids[i:i + 50]
            data = self._get("videos", {"part": "snippet,contentDetails,status", "id": ",".join(chunk)}, COST_DETAILS)
            for it in data.get("items") or []:
                vid = it.get("id") or ""
                sn, cd, st = it.get("snippet") or {}, it.get("contentDetails") or {}, it.get("status") or {}
                rr = cd.get("regionRestriction") or {}
                region_ok = True
                if self.region:
                    if self.region in (rr.get("blocked") or []):
                        region_ok = False
                    if rr.get("allowed") is not None and self.region not in rr.get("allowed"):
                        region_ok = False
                age_restricted = (cd.get("contentRating") or {}).get("ytRating") == "ytAgeRestricted"
                out[vid] = {
                    "id": vid, "title": sn.get("title") or "", "description": sn.get("description") or "",
                    "channel": sn.get("channelTitle") or "", "published_at": parse_dt(sn.get("publishedAt")),
                    "live": (sn.get("liveBroadcastContent") or "none") != "none",
                    "duration_s": duration_seconds(cd.get("duration") or ""),
                    "public": st.get("privacyStatus") == "public" and st.get("uploadStatus", "processed") == "processed",
                    "embeddable": bool(st.get("embeddable")) and not age_restricted, "region_ok": region_ok,
                }
        return out

    @staticmethod
    def links(vid: str) -> dict:
        return {"video_url": f"https://www.youtube.com/watch?v={vid}", "embed_url": f"https://www.youtube-nocookie.com/embed/{vid}",
                "thumbnail_url": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"}


PROVIDERS = {"youtube": YouTubeProvider}    # add another platform here


# ----------------------------------------------------------------------------- what is stored on a story
def video_found(provider: str, cand: dict, links: dict, scored: dict, attempts: int, now: dt.datetime) -> dict:
    return {
        "available": True, "status": "found", "platform": provider, "video_id": cand["id"], "video_url": links["video_url"],
        "embed_url": links["embed_url"], "title": cand["title"], "thumbnail_url": links["thumbnail_url"],
        "duration": fmt_duration(cand["duration_s"]) if cand.get("duration_s") else None,
        "published_at": iso(cand["published_at"]) if cand.get("published_at") else None, "publisher": cand["channel"],
        "relevance_score": round(scored["score"], 2), "is_embeddable": bool(cand["embeddable"]),
        "checked_at": iso(now), "attempts": attempts,
    }


def video_none(attempts: int, best: float, now: dt.datetime) -> dict:
    return {
        "available": False, "status": "none", "platform": None, "video_id": None, "video_url": None, "embed_url": None, "title": None,
        "thumbnail_url": None, "duration": None, "published_at": None, "publisher": None, "relevance_score": 0, "is_embeddable": False,
        "best_score": round(best, 2), "checked_at": iso(now), "attempts": attempts,
    }


# ----------------------------------------------------------------------------- discovery for one story
def discover(feat: dict, providers: list, engine: Engine, cfg: dict, log=lambda m: None) -> tuple[str | None, dict | None, dict | None, float]:
    """Returns (provider name, candidate, scored, best score seen). candidate is None when nothing was good enough."""
    query = build_query(feat)
    after = (feat["published"] or utcnow()) - dt.timedelta(hours=float(cfg["video_lookback_hours"]))
    best_seen = 0.0
    for prov in providers:
        ids = prov.search(query, after, int(cfg["video_max_results"]))
        if not ids:
            continue
        cands = prov.details(ids)
        if not cands:
            continue
        docs = [{"id": v["id"], "headline": v["title"], "text": v["title"] + "\n" + v["description"][:400]} for v in cands.values()]
        try:
            cls = engine.classify(docs)
        except EngineError as exc:
            log(f"    engine unavailable for candidates: {exc}")
            cls = {}
        results = []
        for vid, c in cands.items():
            r = score_candidate(feat, c, cls.get(vid, {}), cfg)
            results.append((r, c))
            if not r["reject"]:
                best_seen = max(best_seen, r["score"])
        ok = [(r, c) for r, c in results if not r["reject"] and r["score"] >= float(cfg["video_min_score"])]
        if ok:
            r, c = max(ok, key=lambda rc: (rc[0]["score"], rc[1]["embeddable"]))
            return prov.name, c, r, best_seen
    return None, None, None, best_seen


# ----------------------------------------------------------------------------- the entry point used by pipeline.py
def enrich_feed(feed: dict, state: dict, settings: dict, *, now: dt.datetime, http, env: dict, root: Path, log=print,
                engine: Engine | None = None, providers: list | None = None) -> dict:
    """Attach the best verified video to each important, recent story. Never raises: failures become a status."""
    cfg = {**DEFAULTS, **{k: v for k, v in settings.items() if k in DEFAULTS}}
    cfg["video_weights"] = {**DEFAULTS["video_weights"], **(cfg.get("video_weights") or {})}
    stats = {"checked": 0, "found": 0, "none": 0, "units": 0, "status": "ok", "changed": False}
    before_meta = json.dumps(feed.get("video_meta"), sort_keys=True)

    def finish(status: str) -> dict:
        stats["status"] = status
        feed["video_meta"] = {"enabled": status in ("ok", "quota"), "status": status, "importance": list(cfg["video_importance"]),
                              "min_score": float(cfg["video_min_score"]), "max_age_hours": float(cfg["video_max_age_hours"])}
        stats["changed"] = stats["changed"] or json.dumps(feed["video_meta"], sort_keys=True) != before_meta
        return stats

    key = (env.get("YOUTUBE_API_KEY") or "").strip()
    secrets = [key]
    try:
        if not cfg["video_enabled"]:
            log("Video discovery: switched off (video_enabled: false).")
            return finish("disabled")
        if not key and providers is None:
            log("Video discovery: no YOUTUBE_API_KEY, so stories keep working without videos. See .env.example.")
            return finish("no_key")
        engine = engine or Engine(root)
        needs_engine = providers is None or any(not i.get("importance") for i in feed.get("items", []))
        if needs_engine and not engine.available():
            log("Video discovery: Node.js (or video_classify.js) not found, so importance cannot be read. Skipping.")
            return finish("no_node")

        vstate = state.setdefault("video", {})
        budget = Budget(vstate, cfg["video_daily_unit_budget"], now)
        if providers is None:
            providers = []
            for name in cfg["video_platforms"]:
                cls_ = PROVIDERS.get(name)
                if not cls_:
                    log(f"Video discovery: platform '{name}' is not available yet, skipping it.")
                    continue
                providers.append(cls_(key, http, budget, cfg["video_region_code"]))
        if not providers:
            return finish("disabled")
        units_at_start = budget.used

        items = feed.get("items", [])
        max_age = dt.timedelta(hours=float(cfg["video_max_age_hours"]))
        recent = [i for i in items if (now - (parse_dt(i.get("published")) or parse_dt(i.get("updated")) or now)) <= max_age]

        # importance, country, sector: from the item (AI mode) or from the app's own engine (free mode)
        analysis: dict[str, dict] = {}
        todo = [i for i in recent if not i.get("importance")]
        if todo:
            docs = [{"id": i["id"], "headline": i.get("headline", ""), "text": i.get("excerpt") or i.get("headline", ""),
                     "date": (i.get("published") or "")[:10]} for i in todo]
            analysis = engine.classify(docs)
        for i in recent:
            analysis.setdefault(i["id"], {"importance": i.get("importance"), "country": i.get("country"), "involved": i.get("involved"),
                                          "sector": i.get("sector"), "companies": i.get("companies")})

        # 1. re-check videos that are already attached (deleted, made private, no longer embeddable)
        every = dt.timedelta(hours=float(cfg["video_revalidate_hours"]))
        stale = [i for i in items if (i.get("video") or {}).get("status") == "found"
                 and now - (parse_dt(i["video"].get("checked_at")) or now - every * 2) >= every]
        yt = next((p for p in providers if p.name == "youtube"), None)
        if stale and yt:
            try:
                live = yt.details([i["video"]["video_id"] for i in stale])
                for i in stale:
                    v = i["video"]
                    d = live.get(v["video_id"])
                    if not d or not d["public"] or not d["region_ok"]:
                        log(f"  video {v['video_id']} is gone or restricted, story {i['id']} will look again")
                        i["video"] = video_none(0, 0, now)
                    else:
                        v["is_embeddable"], v["checked_at"] = d["embeddable"], iso(now)
                    stats["changed"] = True
            except (QuotaError, AuthError, TemporaryError) as exc:
                log(f"  could not re-check attached videos: {redact(exc, secrets)}")

        # 2. find videos for stories that need one, most important and newest first
        want = set(cfg["video_importance"])
        retry = dt.timedelta(minutes=float(cfg["video_retry_minutes"]))
        queue = []
        for i in recent:
            a = analysis.get(i["id"]) or {}
            if a.get("importance") not in want:
                continue
            v = i.get("video") or {}
            if v.get("status") == "found":
                continue
            if v.get("status") == "none":
                if int(v.get("attempts", 0)) >= int(cfg["video_max_attempts"]) or now - (parse_dt(v.get("checked_at")) or now - retry * 2) < retry:
                    continue
            queue.append((IMP_RANK.get(a["importance"], 0), parse_dt(i.get("published")) or now, i, a))
        queue.sort(key=lambda q: (-q[0], -q[1].timestamp()))
        t0 = time.monotonic()
        for _, _, item, a in queue[: int(cfg["video_max_per_run"])]:
            if time.monotonic() - t0 > float(cfg["video_time_budget_seconds"]):
                log("  time budget for this run reached")
                break
            try:
                feat = story_features(item, a)
                pname, cand, scored, best = discover(feat, providers, engine, cfg, log)
            except TemporaryError as exc:
                log(f"  {item['id']}: temporary problem, will retry ({redact(exc, secrets)})")
                continue
            attempts = int((item.get("video") or {}).get("attempts", 0)) + 1
            stats["checked"] += 1
            if cand:
                links = next(p for p in providers if p.name == pname).links(cand["id"])
                item["video"] = video_found(pname, cand, links, scored, attempts, now)
                stats["found"] += 1
                log(f"  + {item['id']} {feat['importance']:<8} {scored['score']:.2f}  {cand['channel']}: {cand['title'][:60]}")
            else:
                item["video"] = video_none(attempts, best, now)
                stats["none"] += 1
                log(f"  - {item['id']} {feat['importance']:<8} no verified video (best {best:.2f})")
            stats["changed"] = True
        stats["units"] = budget.used - units_at_start
        return finish("ok")
    except QuotaError as exc:
        log(f"Video discovery paused: {redact(exc, secrets)}. The news feed is unaffected.")
        return finish("quota")
    except AuthError as exc:
        log(f"Video discovery stopped: {redact(exc, secrets)}. Check YOUTUBE_API_KEY. The news feed is unaffected.")
        return finish("auth")
    except Exception as exc:  # noqa: BLE001  a video problem must never touch the news feed
        log(f"Video discovery skipped: {redact(exc, secrets)}. The news feed is unaffected.")
        return finish("error")


def check(env: dict, root: Path, log=print, http=None) -> None:
    """Lines for `python pipeline.py check`. Spends one YouTube quota unit to prove the key works."""
    key = (env.get("YOUTUBE_API_KEY") or "").strip()
    log(f"Video discovery: YOUTUBE_API_KEY {'found' if key else 'NOT set (videos stay off, everything else works)'}")
    log(f"Video discovery: Node.js {'found' if shutil.which('node') else 'NOT found (needed to read importance)'}, "
        f"video_classify.js {'found' if (Path(root) / 'video_classify.js').exists() else 'MISSING'}")
    if key and http:
        try:
            r = http(f"{YT_API}/videos", params={"part": "id", "id": "dQw4w9WgXcQ", "key": key}, timeout=15)
            reason = ""
            try:
                reason = ((r.json().get("error") or {}).get("errors") or [{}])[0].get("reason", "")
            except Exception:  # noqa: BLE001
                pass
            log("YouTube API: working" if r.status_code == 200 else f"YouTube API: FAILED, HTTP {r.status_code} {reason}".strip())
        except Exception as exc:  # noqa: BLE001
            log(f"YouTube API: FAILED, {redact(exc, [key])}")
