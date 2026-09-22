"""Offline tests for QwickSignal Phase 2.5 (video intelligence). No network, no API key, no extra packages.

    python -m unittest test_video_intel -v

The YouTube API is replaced by a small fake, so these run anywhere. Two tests use the real Node bridge and are
skipped automatically when Node.js is not installed.
"""
import datetime as dt
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import video_intel as vi

ROOT = Path(__file__).resolve().parent
NOW = dt.datetime(2026, 9, 21, 12, 0, tzinfo=dt.timezone.utc)
KEY = "AIzaSyFAKEKEYFORTESTS0123456789abcdef"
D = lambda s: dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


# ------------------------------------------------------------------ fakes
class Resp:
    def __init__(self, status=200, body=None):
        self.status_code, self._body = status, body if body is not None else {}

    def json(self):
        return self._body


def error(status, reason):
    return Resp(status, {"error": {"errors": [{"reason": reason}]}})


class FakeYouTube:
    """Stands in for the YouTube Data API. `videos` maps id -> details; `search_ids` is what a search returns."""

    def __init__(self, videos=None, search_ids=None, fail=None):
        self.videos, self.search_ids, self.fail, self.calls = videos or {}, search_ids, fail, []

    def __call__(self, url, params=None, timeout=None):
        self.calls.append((url.rsplit("/", 1)[-1], dict(params or {})))
        if self.fail:
            if isinstance(self.fail, Exception):
                raise self.fail
            return self.fail
        if url.endswith("/search"):
            ids = self.search_ids if self.search_ids is not None else list(self.videos)
            return Resp(200, {"items": [{"id": {"videoId": i}} for i in ids]})
        want = (params or {}).get("id", "").split(",")
        return Resp(200, {"items": [self.videos[i] for i in want if i in self.videos]})

    def count(self, kind):
        return sum(1 for k, _ in self.calls if k == kind)


def yt_item(vid, title, channel="Reuters", published="2026-09-21T08:00:00Z", duration="PT2M14S", description="",
            embeddable=True, privacy="public", live="none", blocked=None, allowed=None, age_restricted=False):
    cd = {"duration": duration}
    if blocked or allowed is not None:
        cd["regionRestriction"] = {k: v for k, v in (("blocked", blocked), ("allowed", allowed)) if v is not None}
    if age_restricted:
        cd["contentRating"] = {"ytRating": "ytAgeRestricted"}
    return {"id": vid, "snippet": {"title": title, "description": description, "channelTitle": channel, "publishedAt": published,
                                   "liveBroadcastContent": live},
            "contentDetails": cd, "status": {"privacyStatus": privacy, "embeddable": embeddable, "uploadStatus": "processed"}}


class FakeEngine:
    """Reads a video's country from a table instead of running Node."""

    def __init__(self, countries=None):
        self.countries = countries or {}

    def available(self):
        return True

    def classify(self, docs):
        return {d["id"]: {"importance": "Low", "country": self.countries.get(d["id"], "Global"), "involved": [], "sector": "Other", "companies": []}
                for d in docs}


class BrokenEngine(FakeEngine):
    def classify(self, docs):
        raise vi.EngineError("node exploded")


def story(id="s1", headline="Bank of Japan raises rates to 1.25%", importance="High", country="Japan", published="2026-09-21T06:00:00Z", **kw):
    return {"id": id, "ai": True, "headline": headline, "summary": "x", "country": country, "involved": [], "sector": "Banking",
            "importance": importance, "companies": [], "published": published, "updated": published, "sources": [], "related": [], **kw}


GOOD = yt_item("A" * 11, "BOJ raises interest rates to 1.25%, highest in decades", "Reuters", description="The Bank of Japan raised its rate.")
VID = "A" * 11


def run(items, http, settings=None, state=None, engine=None, env=None, now=NOW, log=None, providers=None):
    feed = {"items": items}
    state = state if state is not None else {}
    logs = []
    stats = vi.enrich_feed(feed, state, settings or {}, now=now, http=http, env={"YOUTUBE_API_KEY": KEY} if env is None else env, root=ROOT,
                           log=log or logs.append, engine=engine or FakeEngine({VID: "Japan"}), providers=providers)
    return feed, state, stats, logs


# ------------------------------------------------------------------ matching and scoring
class Matching(unittest.TestCase):
    def feat(self, headline="Bank of Japan raises rates to 1.25%", country="Japan"):
        return vi.story_features(story(headline=headline, country=country), {"importance": "High", "country": country})

    def cand(self, title, channel="Reuters", published="2026-09-21T08:00:00Z", dur=134, **kw):
        return {"id": "x", "title": title, "description": kw.pop("description", ""), "channel": channel, "published_at": D(published),
                "duration_s": dur, "embeddable": True, "live": False, "public": True, "region_ok": True, **kw}

    def score(self, title, country="Japan", **kw):
        cfg = {**vi.DEFAULTS}
        return vi.score_candidate(self.feat(), self.cand(title, **kw), {"country": country, "involved": []}, cfg)

    def test_query_uses_names_action_figures(self):
        q = vi.build_query(self.feat())
        self.assertTrue(q.startswith("Bank of Japan"))
        for w in ("raises", "1.25", "news"):
            self.assertIn(w, q)

    def test_right_video_scores_high(self):
        r = self.score("BOJ raises interest rates to 1.25%, highest in decades")
        self.assertIsNone(r["reject"])
        self.assertGreaterEqual(r["score"], 0.75)

    def test_abbreviation_matches_full_name(self):
        self.assertGreaterEqual(self.score("BOJ raises rates to 1.25%")["parts"]["entity"], 1.0)

    def test_unrelated_video_rejected(self):
        r = self.score("Easy 15 minute pasta recipe", channel="Kitchen Fun")
        self.assertIsNotNone(r["reject"])
        self.assertLess(r["score"], 0.5)

    def test_other_central_bank_rejected(self):
        self.assertIsNotNone(self.score("Fed cuts rates by 25 basis points as markets rally", country="United States")["reject"])

    def test_wrong_country_rejected(self):
        self.assertEqual(self.score("Bank of India raises lending rates to 1.25%", country="India")["reject"], "wrong-country")

    def test_opposite_action_rejected(self):
        self.assertEqual(self.score("Bank of Japan cuts rates to 1.25%")["reject"], "contradicts-action")
        self.assertEqual(self.score("Bank of Japan holds rates steady")["reject"], "contradicts-action")

    def test_wrong_figure_rejected(self):
        self.assertEqual(self.score("BOJ raises interest rates to 0.75%")["reject"], "figure-mismatch")

    def test_old_video_rejected(self):
        self.assertEqual(self.score("Bank of Japan raises rates to 1.25%", published="2026-09-01T08:00:00Z")["reject"], "too-old")

    def test_clickbait_from_unknown_channel_rejected_but_not_from_trusted(self):
        t = "BOJ RATE HIKE 1.25% SHOCKING NEWS!!!"
        self.assertEqual(self.score(t, channel="Money Guru 786")["reject"], "clickbait")
        self.assertIsNone(self.score(t, channel="Reuters")["reject"])

    def test_news_bulletin_is_not_the_video_of_a_story(self):
        self.assertEqual(self.score("Top 10 news today: BOJ raises rates to 1.25%, cricket, weather", channel="NDTV")["reject"], "compilation")

    def test_clip_too_short_or_too_long_rejected(self):
        self.assertEqual(self.score("BOJ raises rates to 1.25%", dur=12)["reject"], "duration")
        self.assertEqual(self.score("BOJ raises rates to 1.25%", dur=5000)["reject"], "duration")

    def test_live_private_and_blocked_rejected(self):
        self.assertEqual(self.score("BOJ raises rates to 1.25%", live=True)["reject"], "live-or-upcoming")
        self.assertEqual(self.score("BOJ raises rates to 1.25%", public=False)["reject"], "not-public")
        self.assertEqual(self.score("BOJ raises rates to 1.25%", region_ok=False)["reject"], "region-blocked")

    def test_score_is_between_0_and_1_and_weights_are_normalised(self):
        f, c = self.feat(), self.cand("BOJ raises rates to 1.25%")
        for w in ({"event": 35, "entity": 20, "action": 15, "geo": 10, "recency": 10, "source": 10}, {"event": 1}):
            cfg = {**vi.DEFAULTS, "video_weights": w}
            s = vi.score_candidate(f, c, {"country": "Japan"}, cfg)["score"]
            self.assertTrue(0 <= s <= 1, s)

    def test_default_weights_match_the_spec(self):
        self.assertEqual(vi.DEFAULTS["video_weights"], {"event": .35, "entity": .20, "action": .15, "geo": .10, "recency": .10, "source": .10})
        self.assertEqual(vi.DEFAULTS["video_min_score"], 0.75)

    def test_long_headlines_still_match_on_their_first_clause(self):
        h = ("Iran and Oman have agreed to jointly inspect commercial vessels transiting the Strait of Hormuz after a week of tension in the Gulf, "
             "according to two officials briefed on the talks. The arrangement would cover tankers bound for India, China and Japan and is expected "
             "to be announced after a meeting of foreign ministers next week while analysts said enforcement details remain unclear.")
        f = vi.story_features(story(headline=h, country="Global"), {"importance": "High", "country": "Global"})
        self.assertLessEqual(len(f["focus"]), 220)
        c = self.cand("Iran and Oman agree joint inspections of ships in the Strait of Hormuz", channel="Al Jazeera English")
        r = vi.score_candidate(f, c, {"country": "Iran"}, {**vi.DEFAULTS})
        self.assertIsNone(r["reject"])
        self.assertGreaterEqual(r["score"], 0.75)

    def test_helpers(self):
        self.assertEqual(vi.duration_seconds("PT2M14S"), 134)
        self.assertEqual(vi.duration_seconds("PT1H2M3S"), 3723)
        self.assertEqual(vi.fmt_duration(134), "2:14")
        self.assertEqual(vi.fmt_duration(3723), "1:02:03")
        self.assertNotIn("SECRET1234567890", vi.redact("GET /x?a=1&key=SECRET1234567890 failed", ["SECRET1234567890"]))


# ------------------------------------------------------------------ the whole flow
class Discovery(unittest.TestCase):
    def test_video_found_and_attached_with_the_spec_fields(self):
        yt = FakeYouTube({VID: GOOD})
        feed, state, stats, _ = run([story()], yt)
        v = feed["items"][0]["video"]
        self.assertTrue(v["available"])
        self.assertEqual((v["platform"], v["video_id"], v["publisher"], v["duration"], v["is_embeddable"]), ("youtube", VID, "Reuters", "2:14", True))
        self.assertEqual(v["video_url"], f"https://www.youtube.com/watch?v={VID}")
        self.assertEqual(v["embed_url"], f"https://www.youtube-nocookie.com/embed/{VID}")
        self.assertTrue(v["thumbnail_url"].startswith("https://i.ytimg.com/"))
        self.assertGreaterEqual(v["relevance_score"], 0.75)
        for k in ("title", "published_at", "relevance_score"):
            self.assertIn(k, v)
        self.assertEqual((stats["found"], stats["status"]), (1, "ok"))

    def test_external_video_when_it_cannot_be_embedded(self):
        feed, *_ = run([story()], FakeYouTube({VID: yt_item(VID, GOOD["snippet"]["title"], embeddable=False, description="BOJ")}))
        v = feed["items"][0]["video"]
        self.assertTrue(v["available"])
        self.assertFalse(v["is_embeddable"])

    def test_age_restricted_video_is_not_embedded(self):
        feed, *_ = run([story()], FakeYouTube({VID: yt_item(VID, GOOD["snippet"]["title"], age_restricted=True)}))
        self.assertFalse(feed["items"][0]["video"]["is_embeddable"])

    def test_no_search_results_means_no_verified_video(self):
        feed, _, stats, _ = run([story()], FakeYouTube({}, search_ids=[]))
        v = feed["items"][0]["video"]
        self.assertFalse(v["available"])
        self.assertEqual(v["status"], "none")
        for k in ("platform", "video_id", "video_url", "embed_url", "title", "thumbnail_url", "duration", "published_at", "publisher"):
            self.assertIsNone(v[k], k)
        self.assertEqual((v["relevance_score"], v["is_embeddable"]), (0, False))
        self.assertEqual(stats["none"], 1)

    def test_bad_match_is_rejected_not_attached(self):
        bad = yt_item(VID, "Fed cuts rates by 25 basis points as markets rally", "CNBC Television")
        feed, *_ = run([story()], FakeYouTube({VID: bad}), engine=FakeEngine({VID: "United States"}))
        self.assertFalse(feed["items"][0]["video"]["available"])

    def test_first_result_is_not_taken_the_best_scoring_one_is(self):
        a, b = "B" * 11, "C" * 11
        vids = {a: yt_item(a, "Japan weather forecast this week", "Some Channel"),
                b: yt_item(b, "Bank of Japan raises rates to 1.25 percent", "Bloomberg Television")}
        feed, *_ = run([story()], FakeYouTube(vids, search_ids=[a, b]), engine=FakeEngine({a: "Japan", b: "Japan"}))
        self.assertEqual(feed["items"][0]["video"]["video_id"], b)

    def test_threshold_is_configurable(self):
        feed, *_ = run([story()], FakeYouTube({VID: GOOD}), settings={"video_min_score": 0.99})
        self.assertFalse(feed["items"][0]["video"]["available"])

    def test_stories_without_video_data_are_left_alone(self):
        low = story("s2", importance="Low")
        feed, *_ = run([story(), low], FakeYouTube({VID: GOOD}))
        self.assertNotIn("video", low)
        self.assertEqual(low["headline"], "Bank of Japan raises rates to 1.25%")

    def test_only_important_stories_are_searched_medium_is_optional(self):
        med = story("m1", importance="Medium")
        yt = FakeYouTube({VID: GOOD})
        run([med], yt)
        self.assertEqual(yt.count("search"), 0)
        yt2 = FakeYouTube({VID: GOOD})
        feed, *_ = run([story("m2", importance="Medium")], yt2, settings={"video_importance": ["Critical", "High", "Medium"]})
        self.assertEqual(yt2.count("search"), 1)
        self.assertTrue(feed["items"][0]["video"]["available"])

    def test_old_stories_are_not_searched(self):
        yt = FakeYouTube({VID: GOOD})
        run([story(published="2026-09-18T06:00:00Z")], yt)
        self.assertEqual(yt.count("search"), 0)

    def test_most_important_first_and_per_run_cap(self):
        items = [story(f"s{i}", importance="High", published=f"2026-09-21T0{i}:00:00Z") for i in range(1, 5)] + [story("crit", importance="Critical", published="2026-09-21T01:00:00Z")]
        yt = FakeYouTube({}, search_ids=[])
        feed, *_ = run(items, yt, settings={"video_max_per_run": 3})
        self.assertEqual(yt.count("search"), 3)
        self.assertIn("video", next(i for i in feed["items"] if i["id"] == "crit"))

    def test_results_are_cached_no_second_search_for_a_finished_story(self):
        yt = FakeYouTube({VID: GOOD})
        feed, state, *_ = run([story()], yt)
        n = len(yt.calls)
        run(feed["items"], yt, state=state)
        self.assertEqual(len(yt.calls), n)

    def test_retry_policy_waits_then_tries_again_then_gives_up(self):
        yt = FakeYouTube({}, search_ids=[])
        feed, state, *_ = run([story()], yt)
        self.assertEqual(yt.count("search"), 1)
        run(feed["items"], yt, state=state, now=NOW + dt.timedelta(minutes=30))
        self.assertEqual(yt.count("search"), 1)                                   # too soon
        for k in (1, 2):
            run(feed["items"], yt, state=state, now=NOW + dt.timedelta(minutes=125 * k))
        self.assertEqual(yt.count("search"), 3)                                   # three tries in total
        run(feed["items"], yt, state=state, now=NOW + dt.timedelta(minutes=125 * 3))
        self.assertEqual(yt.count("search"), 3)                                   # then it stops

    def test_a_later_try_can_find_the_video(self):
        yt = FakeYouTube({}, search_ids=[])
        feed, state, *_ = run([story()], yt)
        yt.videos, yt.search_ids = {VID: GOOD}, None
        run(feed["items"], yt, state=state, now=NOW + dt.timedelta(minutes=130))
        self.assertTrue(feed["items"][0]["video"]["available"])

    def test_daily_budget_stops_searching(self):
        yt = FakeYouTube({}, search_ids=[])
        items = [story(f"s{i}", published=f"2026-09-21T0{i}:00:00Z") for i in range(1, 6)]
        feed, state, stats, _ = run(items, yt, settings={"video_daily_unit_budget": 250, "video_max_per_run": 8})
        self.assertLessEqual(state["video"]["units"], 250)
        self.assertEqual(stats["status"], "quota")

    def test_deleted_video_is_dropped_on_recheck(self):
        yt = FakeYouTube({VID: GOOD})
        feed, state, *_ = run([story()], yt)
        yt.videos = {}                                                             # the video disappears from YouTube
        yt.search_ids = []
        run(feed["items"], yt, state=state, now=NOW + dt.timedelta(hours=7))
        self.assertFalse(feed["items"][0]["video"]["available"])

    def test_video_that_stops_being_embeddable_is_downgraded_on_recheck(self):
        yt = FakeYouTube({VID: GOOD})
        feed, state, *_ = run([story()], yt)
        yt.videos = {VID: yt_item(VID, GOOD["snippet"]["title"], embeddable=False)}
        run(feed["items"], yt, state=state, now=NOW + dt.timedelta(hours=7))
        v = feed["items"][0]["video"]
        self.assertTrue(v["available"])
        self.assertFalse(v["is_embeddable"])

    def test_region_blocked_video_is_skipped(self):
        feed, *_ = run([story()], FakeYouTube({VID: yt_item(VID, GOOD["snippet"]["title"], blocked=["IN"])}))
        self.assertFalse(feed["items"][0]["video"]["available"])
        feed, *_ = run([story()], FakeYouTube({VID: yt_item(VID, GOOD["snippet"]["title"], allowed=["US"])}))
        self.assertFalse(feed["items"][0]["video"]["available"])

    def test_the_api_key_is_sent_only_to_google_and_never_stored(self):
        yt = FakeYouTube({VID: GOOD})
        feed, state, _, logs = run([story()], yt)
        self.assertNotIn(KEY, json.dumps(feed) + json.dumps(state) + "\n".join(logs))


# ------------------------------------------------------------------ failures must never break the news
class Failures(unittest.TestCase):
    def assert_news_intact(self, feed, items_before):
        self.assertEqual([i["headline"] for i in feed["items"]], items_before)
        self.assertEqual(len(feed["items"]), len(items_before))

    def test_missing_api_key_switches_video_off_quietly(self):
        yt = FakeYouTube({VID: GOOD})
        feed, _, stats, logs = run([story()], yt, env={})
        self.assertEqual(stats["status"], "no_key")
        self.assertEqual(yt.calls, [])
        self.assertNotIn("video", feed["items"][0])
        self.assertFalse(feed["video_meta"]["enabled"])

    def test_video_discovery_can_be_switched_off(self):
        yt = FakeYouTube({VID: GOOD})
        feed, _, stats, _ = run([story()], yt, settings={"video_enabled": False})
        self.assertEqual((stats["status"], yt.calls), ("disabled", []))

    def test_quota_exhausted_pauses_video_and_keeps_the_news(self):
        yt = FakeYouTube(fail=error(403, "quotaExceeded"))
        feed, state, stats, logs = run([story()], yt)
        self.assertEqual(stats["status"], "quota")
        self.assert_news_intact(feed, ["Bank of Japan raises rates to 1.25%"])
        self.assertNotIn("video", feed["items"][0])
        self.assertTrue(state["video"]["blocked_until"])
        n = len(yt.calls)
        run(feed["items"], yt, state=state, now=NOW + dt.timedelta(minutes=15))    # still cooling down: no more requests
        self.assertEqual(len(yt.calls), n)

    def test_rate_limit_429(self):
        feed, _, stats, _ = run([story()], FakeYouTube(fail=Resp(429, {})))
        self.assertEqual(stats["status"], "quota")

    def test_invalid_key_stops_video_and_hides_the_key(self):
        feed, _, stats, logs = run([story()], FakeYouTube(fail=error(400, "keyInvalid")))
        self.assertEqual(stats["status"], "auth")
        self.assertNotIn(KEY, "\n".join(logs))
        self.assert_news_intact(feed, ["Bank of Japan raises rates to 1.25%"])

    def test_network_timeout_skips_the_story_and_hides_the_key(self):
        boom = TimeoutError(f"HTTPSConnectionPool: Read timed out. url: /youtube/v3/search?q=x&key={KEY}")
        feed, _, stats, logs = run([story()], FakeYouTube(fail=boom))
        self.assertEqual(stats["status"], "ok")
        self.assertNotIn("video", feed["items"][0])                                # nothing recorded, so it is retried next run
        self.assertNotIn(KEY, "\n".join(logs))
        self.assertTrue(any("temporary" in l for l in logs))

    def test_server_error_500_is_temporary(self):
        feed, _, stats, _ = run([story()], FakeYouTube(fail=Resp(503, {})))
        self.assertEqual(stats["status"], "ok")
        self.assertNotIn("video", feed["items"][0])

    def test_garbage_response_does_not_crash(self):
        class Bad(Resp):
            def json(self):
                raise ValueError("not json")
        feed, _, stats, _ = run([story()], FakeYouTube(fail=Bad(200)))
        self.assertIn(stats["status"], ("ok",))

    def test_a_crash_inside_discovery_is_contained(self):
        class Boom:
            name = "youtube"

            def search(self, *a, **k):
                raise RuntimeError("unexpected bug")

            def details(self, *a):
                return {}
        feed, _, stats, _ = run([story()], None, providers=[Boom()])
        self.assertEqual(stats["status"], "error")
        self.assert_news_intact(feed, ["Bank of Japan raises rates to 1.25%"])

    def test_engine_failure_for_candidates_still_works(self):
        feed, *_ = run([story()], FakeYouTube({VID: GOOD}), engine=BrokenEngine())
        self.assertTrue(feed["items"][0]["video"]["available"])

    def test_node_missing_is_reported_not_fatal(self):
        class NoNode(FakeEngine):
            def available(self):
                return False
        feed, _, stats, _ = run([{**story(), "importance": None}], FakeYouTube({VID: GOOD}), engine=NoNode())
        self.assertEqual(stats["status"], "no_node")

    def test_unknown_platform_in_settings_is_ignored(self):
        feed, _, stats, logs = run([story()], FakeYouTube({VID: GOOD}), settings={"video_platforms": ["instagram", "youtube"]})
        self.assertTrue(feed["items"][0]["video"]["available"])
        self.assertTrue(any("instagram" in l for l in logs))


# ------------------------------------------------------------------ with the real Node bridge and the real pipeline
@unittest.skipUnless(shutil.which("node"), "Node.js not installed")
class WithNode(unittest.TestCase):
    def test_bridge_reads_a_story_like_the_app_does(self):
        out = vi.Engine(ROOT).classify([{"id": "a", "headline": "Missile strike hits Kharkiv power station, casualties reported",
                                         "text": "Missile strike hits Kharkiv power station, casualties reported by Ukraine officials"}])
        self.assertEqual((out["a"]["importance"], out["a"]["country"]), ("Critical", "Ukraine"))

    def test_free_mode_story_without_importance_is_classified_by_the_app_engine(self):
        s = {"id": "f1", "ai": False, "headline": "Missile strike hits Kharkiv power station, casualties reported",
             "excerpt": "Missile strike hits Kharkiv power station, casualties reported by Ukraine officials", "published": "2026-09-21T06:00:00Z",
             "updated": "2026-09-21T06:00:00Z", "sources": [], "related": []}
        v = "K" * 11
        yt = FakeYouTube({v: yt_item(v, "Missile strike hits Kharkiv power station, casualties reported", "Reuters", description="Ukraine officials")})
        feed = {"items": [s]}
        stats = vi.enrich_feed(feed, {}, {}, now=NOW, http=yt, env={"YOUTUBE_API_KEY": KEY}, root=ROOT, log=lambda m: None)
        self.assertEqual(stats["found"], 1, stats)
        self.assertEqual(feed["items"][0]["video"]["video_id"], v)


class PipelineCommand(unittest.TestCase):
    def test_videos_command_never_fails_and_leaves_the_feed_readable(self):
        import pipeline
        tmp = Path(tempfile.mkdtemp())
        old = dict(pipeline.PATHS)
        try:
            for k in pipeline.PATHS:
                pipeline.PATHS[k] = tmp / Path(old[k]).name
            (tmp / "feed.json").write_text("{this is not json", encoding="utf-8")       # a corrupt feed
            self.assertEqual(pipeline.cmd_videos(), 0)
            (tmp / "feed.json").write_text(json.dumps({"items": [story()]}), encoding="utf-8")
            self.assertEqual(pipeline.cmd_videos(), 0)                                   # no key: quiet, unchanged
            feed = json.loads((tmp / "feed.json").read_text(encoding="utf-8"))
            self.assertEqual(feed["items"][0]["headline"], "Bank of Japan raises rates to 1.25%")
        finally:
            pipeline.PATHS.update(old)
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
