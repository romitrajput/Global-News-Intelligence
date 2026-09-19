/* Global News Intelligence, Phase 1
   Everything runs in the browser. No accounts, no server, no AI calls.
   Part 1: the engine (pure logic). Part 2: the interface. */
'use strict';

const Engine = (function () {
  /* ---------- text helpers ---------- */
  const STOP = new Set(('a an the and or but if then of to in on at by for with from as is are was were be been being it its ' +
    'this that these those he she they we you i not no nor so than too very can will would could should may might must has have ' +
    'had do does did done into over under about after before during between against per via also more most other such only own ' +
    'same just up down out off again further once here there when where why how all any both each few some what which who whom ' +
    'said says say new one two mr mrs ms dr according reported report reports today yesterday tomorrow week month year years ' +
    'while amid however their them his her our your than then still even much many made make makes').split(' '));

  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reCache = new Map();

  // Keyword syntax: "chip" (plural allowed), "sanction*" (wildcard), "cs:AI" (case-sensitive)
  function rx(term) {
    if (reCache.has(term)) return reCache.get(term);
    let t = term, cs = false;
    if (t.startsWith('cs:')) { cs = true; t = t.slice(3); }
    let body = escRe(t).replace(/\\\*/g, '[A-Za-z0-9]*').replace(/\s+/g, '\\s+');
    if (!cs && !t.includes('*') && /^[a-z][a-z &-]*[a-z]$/i.test(t)) body += '(?:s|es)?';
    const re = new RegExp('(?<![A-Za-z0-9_])' + body + '(?![A-Za-z0-9_])', cs ? 'g' : 'gi');
    reCache.set(term, re);
    return re;
  }
  const count = (text, term) => (text.match(rx(term)) || []).length;

  function stem(t) {
    t = t.replace(/'s$/, '').replace(/\./g, '');
    if (t.length > 5) {
      if (t.endsWith('ies')) return t.slice(0, -3) + 'y';
      if (t.endsWith('ing')) return t.slice(0, -3);
      if (t.endsWith('ed')) return t.slice(0, -2);
      if (t.endsWith('es')) return t.slice(0, -2);
    }
    if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
    return t;
  }
  function tokens(str) {
    const m = str.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]+(?:[.'][a-z0-9]+)*/g) || [];
    return m.map(stem).filter(t => t.length > 2 && !STOP.has(t));
  }
  function topTerms(toks, n) {
    const f = new Map();
    toks.forEach((t, i) => { const e = f.get(t); if (e) e.c++; else f.set(t, { c: 1, i }); });
    return [...f.entries()].sort((a, b) => b[1].c - a[1].c || a[1].i - b[1].i).slice(0, n).map(e => e[0]);
  }
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  /* ---------- countries ---------- */
  // code | name | aliases (cs: = case-sensitive)
  const COUNTRY_ROWS = [
    'US|United States|United States|cs:US|cs:U.S.|USA|America|American|Americans|Washington|White House|Federal Reserve|FOMC|cs:Fed|Pentagon|Wall Street|Nasdaq|S&P 500|Dow Jones|Capitol Hill|US Treasury|Treasury Department',
    'CN|China|China|Chinese|Beijing|PBOC|People\'s Bank of China|Shanghai|Shenzhen|Xi Jinping|Yuan|Renminbi|Guangdong|CSRC',
    'IN|India|India|Indian|Indians|New Delhi|Delhi|Mumbai|RBI|Reserve Bank of India|SEBI|Sensex|Nifty|Rupee|NITI Aayog|Lok Sabha|Modi|Bengaluru|Bangalore|Chennai|Hyderabad|Gujarat|Maharashtra',
    'RU|Russia|Russia|Russian|Moscow|Kremlin|Putin|Rouble|Ruble',
    'UA|Ukraine|Ukraine|Ukrainian|Kyiv|Kiev|Zelensky|Zelenskyy|Donbas|Crimea',
    'JP|Japan|Japan|Japanese|Tokyo|Bank of Japan|cs:BOJ|Nikkei|Yen|Osaka',
    'DE|Germany|Germany|German|Berlin|Bundesbank|DAX|Frankfurt|Bavaria',
    'FR|France|France|French|Paris|Macron|Elysee',
    'GB|United Kingdom|United Kingdom|cs:UK|cs:U.K.|Britain|British|London|Bank of England|cs:BoE|FTSE|Sterling|Downing Street|England|Scotland',
    'IT|Italy|Italy|Italian|Rome|Milan',
    'ES|Spain|Spain|Spanish|Madrid',
    'NL|Netherlands|Netherlands|Dutch|Amsterdam|The Hague',
    'CH|Switzerland|Switzerland|Swiss|Zurich|Geneva',
    'SE|Sweden|Sweden|Swedish|Stockholm',
    'NO|Norway|Norway|Norwegian|Oslo',
    'DK|Denmark|Denmark|Danish|Copenhagen',
    'PL|Poland|Poland|Polish|Warsaw',
    'IE|Ireland|Ireland|Irish|Dublin',
    'GR|Greece|Greece|Greek|Athens',
    'TR|Turkey|Turkey|Turkish|Turkiye|Ankara|Istanbul',
    'EU|European Union|European Union|cs:EU|Eurozone|Euro area|Brussels|European Commission|European Parliament|ECB|European Central Bank',
    'CA|Canada|Canada|Canadian|Ottawa|Toronto|Bank of Canada',
    'MX|Mexico|Mexico|Mexican|Mexico City|Banxico',
    'BR|Brazil|Brazil|Brazilian|Brasilia|Sao Paulo',
    'AR|Argentina|Argentina|Argentine|Buenos Aires',
    'CL|Chile|Chile|Chilean|Santiago',
    'PE|Peru|Peru|Peruvian|Lima',
    'CO|Colombia|Colombia|Colombian|Bogota',
    'VE|Venezuela|Venezuela|Venezuelan|Caracas',
    'AU|Australia|Australia|Australian|Canberra|Sydney|Melbourne|cs:RBA',
    'NZ|New Zealand|New Zealand|Wellington|Auckland',
    'KR|South Korea|South Korea|South Korean|Seoul|KOSPI',
    'KP|North Korea|North Korea|North Korean|Pyongyang',
    'TW|Taiwan|Taiwan|Taiwanese|Taipei',
    'SG|Singapore|Singapore|Singaporean',
    'ID|Indonesia|Indonesia|Indonesian|Jakarta',
    'MY|Malaysia|Malaysia|Malaysian|Kuala Lumpur',
    'TH|Thailand|Thailand|Thai|Bangkok',
    'VN|Vietnam|Vietnam|Vietnamese|Hanoi',
    'PH|Philippines|Philippines|Philippine|Filipino|Manila',
    'PK|Pakistan|Pakistan|Pakistani|Islamabad|Karachi',
    'BD|Bangladesh|Bangladesh|Bangladeshi|Dhaka',
    'LK|Sri Lanka|Sri Lanka|Sri Lankan|Colombo',
    'NP|Nepal|Nepal|Nepali|Kathmandu',
    'AF|Afghanistan|Afghanistan|Afghan|Kabul|Taliban',
    'MM|Myanmar|Myanmar|Burma|Burmese|Yangon',
    'IR|Iran|Iran|Iranian|Tehran',
    'IQ|Iraq|Iraq|Iraqi|Baghdad',
    'IL|Israel|Israel|Israeli|Tel Aviv|Jerusalem|Knesset|cs:IDF',
    'PS|Palestine|Gaza|Palestinian|Palestinians|Palestine|West Bank|Hamas',
    'LB|Lebanon|Lebanon|Lebanese|Beirut|Hezbollah',
    'SY|Syria|Syria|Syrian|Damascus',
    'YE|Yemen|Yemen|Yemeni|Houthi|Houthis',
    'SA|Saudi Arabia|Saudi Arabia|Saudi|Riyadh',
    'AE|UAE|United Arab Emirates|cs:UAE|Dubai|Abu Dhabi|Emirati',
    'QA|Qatar|Qatar|Qatari|Doha',
    'KW|Kuwait|Kuwait|Kuwaiti',
    'OM|Oman|Oman|Omani|Muscat',
    'EG|Egypt|Egypt|Egyptian|Cairo|Suez',
    'ZA|South Africa|South Africa|South African|Johannesburg|Pretoria',
    'NG|Nigeria|Nigeria|Nigerian|Lagos|Abuja',
    'KE|Kenya|Kenya|Kenyan|Nairobi',
    'ET|Ethiopia|Ethiopia|Ethiopian|Addis Ababa',
    'GH|Ghana|Ghana|Ghanaian|Accra',
    'MA|Morocco|Morocco|Moroccan|Rabat',
    'DZ|Algeria|Algeria|Algerian|Algiers',
    'LY|Libya|Libya|Libyan|Tripoli',
    'CD|DR Congo|Democratic Republic of Congo|DR Congo|cs:DRC|Kinshasa'
  ];
  const COUNTRIES = COUNTRY_ROWS.map(r => {
    const p = r.split('|');
    return { code: p[0], name: p[1], aliases: p.slice(2) };
  });
  const COUNTRY_BY_NAME = Object.fromEntries(COUNTRIES.map(c => [c.name, c]));
  COUNTRY_BY_NAME['Global'] = { code: 'GL', name: 'Global', aliases: [] };
  const COUNTRY_NAMES = ['Global'].concat(COUNTRIES.map(c => c.name).sort());

  function flag(code) {
    if (!code || code === 'GL' || code.length !== 2) return '\u{1F310}';
    return String.fromCodePoint(...[...code.toUpperCase()].map(ch => 127397 + ch.charCodeAt(0)));
  }

  const GLOBAL_CUES = ['global', 'globally', 'worldwide', 'world economy', 'across the world', 'around the world',
    'world trade', 'international markets', 'OPEC', 'IMF', 'World Bank', 'WTO', 'G20', 'G7', 'oil prices', 'shipping rates'];

  /* ---------- companies (name | home country code | sector | extra aliases) ---------- */
  const COMPANY_ROWS = [
    'Tata Motors|IN|Automotive', 'Maruti Suzuki|IN|Automotive', 'Mahindra & Mahindra|IN|Automotive|Mahindra', 'Ashok Leyland|IN|Automotive',
    'Bajaj Auto|IN|Automotive', 'Tata Steel|IN|Metals & Mining', 'JSW Steel|IN|Metals & Mining', 'Hindalco|IN|Metals & Mining',
    'Reliance Industries|IN|Energy|Reliance', 'Infosys|IN|Technology', 'Tata Consultancy Services|IN|Technology|TCS', 'Wipro|IN|Technology',
    'HCLTech|IN|Technology', 'HDFC Bank|IN|Banking', 'ICICI Bank|IN|Banking', 'State Bank of India|IN|Banking|SBI', 'Adani|IN|Infrastructure',
    'Bharti Airtel|IN|Telecom|Airtel', 'Jio|IN|Telecom', 'Apple|US|Technology', 'Microsoft|US|Technology', 'Alphabet|US|Technology|Google',
    'Amazon|US|Consumer', 'Meta|US|Technology', 'Nvidia|US|Semiconductors', 'Tesla|US|Automotive', 'Intel|US|Semiconductors',
    'AMD|US|Semiconductors', 'Micron|US|Semiconductors', 'Qualcomm|US|Semiconductors', 'Broadcom|US|Semiconductors',
    'Applied Materials|US|Semiconductors', 'Lam Research|US|Semiconductors', 'KLA|US|Semiconductors', 'Boeing|US|Aerospace',
    'Ford|US|Automotive', 'General Motors|US|Automotive', 'ExxonMobil|US|Energy|Exxon', 'Chevron|US|Energy', 'JPMorgan|US|Banking',
    'Goldman Sachs|US|Finance', 'Pfizer|US|Pharmaceuticals', 'OpenAI|US|Technology', 'ASML|NL|Semiconductors', 'TSMC|TW|Semiconductors',
    'Samsung|KR|Technology', 'SK Hynix|KR|Semiconductors', 'Hyundai|KR|Automotive', 'Toyota|JP|Automotive', 'Honda|JP|Automotive',
    'Nissan|JP|Automotive', 'Sony|JP|Technology', 'Tokyo Electron|JP|Semiconductors', 'SoftBank|JP|Finance', 'BYD|CN|Automotive',
    'Huawei|CN|Technology', 'Alibaba|CN|Consumer', 'Tencent|CN|Technology', 'CATL|CN|Automotive', 'SMIC|CN|Semiconductors',
    'Xiaomi|CN|Technology', 'Volkswagen|DE|Automotive', 'BMW|DE|Automotive', 'Siemens|DE|Manufacturing', 'Bosch|DE|Automotive',
    'Mercedes-Benz|DE|Automotive', 'Stellantis|NL|Automotive', 'Airbus|FR|Aerospace', 'Saudi Aramco|SA|Energy|Aramco', 'Gazprom|RU|Energy',
    'Shell|GB|Energy', 'BP|GB|Energy', 'Rio Tinto|GB|Metals & Mining', 'BHP|AU|Metals & Mining', 'Glencore|CH|Metals & Mining',
    'Vale|BR|Metals & Mining', 'Nestle|CH|Consumer', 'Unilever|GB|Consumer', 'Novo Nordisk|DK|Pharmaceuticals', 'Novartis|CH|Pharmaceuticals',
    'Roche|CH|Pharmaceuticals'
  ];
  const COUNTRY_BY_CODE = Object.fromEntries(COUNTRIES.map(c => [c.code, c.name]));
  const COMPANIES = COMPANY_ROWS.map(r => {
    const p = r.split('|');
    return { name: p[0], code: p[1], sector: p[2], aliases: [p[0]].concat(p[3] ? p[3].split(';') : []) };
  });

  /* ---------- sectors (most specific first, ties go to the earlier one) ---------- */
  const SECTORS = [
    { name: 'Semiconductors', kw: ['semiconductor*', 'chip', 'chipmaker*', 'chipmaking', 'chip-making', 'wafer*', 'foundry', 'foundries', 'lithography', 'EUV', 'fab', 'fabs', 'TSMC', 'ASML', 'Nvidia', 'GPU', 'DRAM', 'NAND', 'integrated circuit*', 'nanometre*', 'nanometer*', 'HBM'],
      sub: { 'Equipment': ['equipment', 'lithography', 'EUV', 'ASML', 'Applied Materials', 'Lam Research', 'Tokyo Electron', 'machinery'], 'Foundry': ['foundry', 'foundries', 'TSMC', 'SMIC', 'wafer*', 'fab', 'fabs'], 'Memory': ['memory', 'DRAM', 'NAND', 'HBM', 'SK Hynix', 'Micron'], 'Chip design': ['GPU', 'Nvidia', 'AMD', 'Qualcomm', 'Broadcom', 'chip design', 'fabless'] } },
    { name: 'Automotive', kw: ['automotive', 'auto industry', 'auto sales', 'automaker*', 'carmaker*', 'car sales', 'car maker*', 'vehicle*', 'passenger vehicle*', 'two-wheeler*', 'OEM', 'OEMs', 'electric vehicle*', 'cs:EV', 'cs:EVs', 'hybrid*', 'ADAS', 'autonomous driving', 'self-driving', 'auto component*', 'auto parts', 'commercial vehicle*', 'truck*', 'SUV*', 'dealership*'],
      sub: { 'EV': ['electric vehicle*', 'cs:EV', 'cs:EVs', 'charging station*', 'charging', 'plug-in', 'BYD', 'Tesla'], 'Batteries': ['battery', 'batteries', 'lithium-ion', 'cathode', 'anode', 'gigafactory', 'CATL'], 'ADAS': ['ADAS', 'autonomous driving', 'self-driving', 'driver assistance', 'lidar'], 'Components': ['auto component*', 'auto parts', 'supplier*', 'tier-1', 'wiring harness', 'transmission'], 'Commercial vehicles': ['commercial vehicle*', 'truck*', 'bus', 'buses', 'fleet'], 'ICE': ['petrol', 'diesel', 'combustion', 'internal combustion'] } },
    { name: 'Pharmaceuticals', kw: ['pharma*', 'drug*', 'FDA', 'USFDA', 'clinical trial*', 'vaccine*', 'biotech*', 'generic*', 'active pharmaceutical*', 'drug approval*', 'medicine*', 'CDSCO', 'biosimilar*', 'drugmaker*'], sub: {} },
    { name: 'Healthcare', kw: ['hospital*', 'healthcare', 'health care', 'patient*', 'medical device*', 'disease*', 'diagnostics', 'cs:WHO', 'public health', 'clinic*', 'doctors'], sub: {} },
    { name: 'Defence', kw: ['defence', 'defense', 'weapon*', 'armed forces', 'army', 'navy', 'air force', 'missile*', 'fighter jet*', 'drone*', 'ammunition', 'submarine*', 'warship*', 'military', 'troops', 'arms deal*', 'Pentagon'], sub: {} },
    { name: 'Aerospace', kw: ['aerospace', 'aircraft', 'aviation', 'airline*', 'airplane*', 'Boeing', 'Airbus', 'satellite*', 'space launch*', 'rocket*', 'ISRO', 'NASA', 'SpaceX', 'jet engine*', 'airport*'], sub: {} },
    { name: 'Metals & Mining', kw: ['copper', 'aluminium', 'aluminum', 'steel', 'iron ore', 'zinc', 'nickel', 'lithium', 'cobalt', 'gold', 'silver', 'mining', 'miner*', 'smelter*', 'rare earth*', 'metal*', 'bauxite', 'coking coal', 'platinum', 'palladium', 'critical mineral*'],
      sub: { 'Steel': ['steel', 'iron ore', 'coking coal'], 'Base metals': ['copper', 'aluminium', 'aluminum', 'zinc', 'nickel', 'smelter*'], 'Precious metals': ['gold', 'silver', 'platinum', 'palladium'], 'Critical minerals': ['lithium', 'cobalt', 'rare earth*', 'critical mineral*'] } },
    { name: 'Energy', kw: ['oil', 'crude', 'Brent', 'WTI', 'OPEC', 'natural gas', 'LNG', 'refiner*', 'refinery', 'refineries', 'pipeline*', 'power plant*', 'electricity', 'power demand', 'coal', 'renewable*', 'solar', 'wind power', 'wind farm*', 'nuclear power', 'hydrogen', 'energy', 'fuel', 'petroleum', 'power grid', 'utilities'],
      sub: { 'Oil & gas': ['oil', 'crude', 'Brent', 'WTI', 'OPEC', 'natural gas', 'LNG', 'refiner*', 'refinery', 'pipeline*', 'petroleum'], 'Power': ['electricity', 'power plant*', 'power demand', 'power grid', 'utilities', 'nuclear power'], 'Renewables': ['renewable*', 'solar', 'wind power', 'wind farm*', 'hydrogen'], 'Coal': ['coal'] } },
    { name: 'Chemicals', kw: ['chemical*', 'petrochemical*', 'polymer*', 'specialty chemical*', 'chlor-alkali', 'solvent*', 'plastic*', 'resin*', 'ammonia', 'methanol'], sub: {} },
    { name: 'Telecom', kw: ['telecom*', '5G', '6G', 'spectrum', 'broadband', 'mobile subscriber*', 'Jio', 'Airtel', 'Vodafone', 'telco*', 'fibre', 'fiber optic*', 'satellite internet'], sub: {} },
    { name: 'Technology', kw: ['artificial intelligence', 'cs:AI', 'machine learning', 'LLM', 'chatbot*', 'generative', 'OpenAI', 'cloud', 'data centre*', 'data center*', 'cybersecurity', 'cyberattack*', 'cyber attack*', 'ransomware', 'hack*', 'software', 'SaaS', 'algorithm*', 'smartphone*', 'quantum', 'robotics', 'big tech', 'startup*', 'tech company', 'tech companies', 'operating system*', 'app store'],
      sub: { 'AI': ['artificial intelligence', 'cs:AI', 'machine learning', 'LLM', 'chatbot*', 'generative', 'OpenAI', 'GPU*'], 'Cloud': ['cloud', 'data centre*', 'data center*', 'AWS', 'Azure', 'hyperscaler*'], 'Cybersecurity': ['cybersecurity', 'cyberattack*', 'cyber attack*', 'ransomware', 'hack*', 'breach*', 'malware', 'data leak*'], 'Software': ['software', 'SaaS', 'app store', 'operating system*'], 'Hardware': ['smartphone*', 'laptop*', 'devices', 'hardware', 'wearable*', 'electronics'] } },
    { name: 'Banking', kw: ['bank', 'banks', 'banking', 'central bank*', 'Federal Reserve', 'FOMC', 'ECB', 'interest rate*', 'rate cut*', 'rate hike*', 'basis points', 'monetary policy', 'lender*', 'lending', 'loan*', 'NPA', 'NPAs', 'NBFC*', 'credit growth', 'deposit*', 'repo rate', 'Basel', 'mortgage*', 'fintech', 'UPI', 'RBI', 'PBOC'],
      sub: { 'Monetary policy': ['central bank*', 'Federal Reserve', 'FOMC', 'ECB', 'interest rate*', 'rate cut*', 'rate hike*', 'basis points', 'monetary policy', 'repo rate', 'RBI', 'PBOC'], 'Lending': ['lender*', 'lending', 'loan*', 'NPA', 'NPAs', 'credit growth', 'mortgage*', 'NBFC*'], 'Fintech': ['fintech', 'UPI', 'digital payment*'] } },
    { name: 'Finance', kw: ['stock market*', 'equity market*', 'equities', 'bond*', 'yield*', 'currency', 'forex', 'IPO', 'merger*', 'acquisition*', 'private equity', 'venture capital', 'hedge fund*', 'investor*', 'crypto*', 'bitcoin', 'mutual fund*', 'dividend*', 'valuation*', 'credit rating*', 'downgrade*', 'upgrade*', 'funding round*', 'shares'], sub: {} },
    { name: 'Logistics', kw: ['logistics', 'shipping', 'freight', 'cargo', 'container*', 'port', 'ports', 'supply chain*', 'Red Sea', 'Suez', 'Panama Canal', 'railway*', 'trucking', 'warehous*', 'vessel*', 'tanker*', 'shipping line*'], sub: {} },
    { name: 'Agriculture', kw: ['agricultur*', 'crop*', 'farm*', 'wheat', 'rice', 'corn', 'soybean*', 'sugar', 'monsoon', 'fertilizer*', 'fertiliser*', 'pesticide*', 'harvest*', 'food prices', 'irrigation', 'edible oil', 'palm oil', 'cotton'], sub: {} },
    { name: 'Climate', kw: ['climate', 'emission*', 'carbon', 'net zero', 'net-zero', 'global warming', 'heatwave*', 'flood*', 'drought*', 'hurricane*', 'cyclone*', 'wildfire*', 'sea level', 'ESG', 'greenhouse', 'cs:COP30'], sub: {} },
    { name: 'Infrastructure', kw: ['infrastructure', 'highway*', 'bridge*', 'metro', 'airport', 'construction', 'cement', 'real estate', 'housing', 'smart city', 'tunnel*', 'dam', 'dams', 'urban development'], sub: {} },
    { name: 'Manufacturing', kw: ['manufactur*', 'factory', 'factories', 'plant closure*', 'industrial output', 'PLI scheme', 'assembly line*', 'capacity expansion', 'machinery', 'industrial production', 'PMI'], sub: {} },
    { name: 'Consumer', kw: ['consumer*', 'retail', 'retailer*', 'FMCG', 'e-commerce', 'ecommerce', 'brand*', 'restaurant*', 'apparel', 'footwear', 'luxury', 'household', 'consumer spending', 'consumption', 'festive demand'], sub: {} },
    { name: 'Economy', kw: ['GDP', 'inflation', 'CPI', 'recession', 'unemployment', 'jobs report', 'growth forecast*', 'fiscal', 'deficit*', 'trade deficit', 'economic', 'economy', 'economies', 'stimulus', 'tariff*', 'trade war', 'imports', 'exports', 'consumer confidence', 'retail sales', 'budget', 'wage*', 'trade agreement*', 'trade deal*'], sub: {} },
    { name: 'Geopolitics', kw: ['war', 'ceasefire', 'invasion', 'sanction*', 'diplomatic', 'diplomacy', 'summit', 'treaty', 'border', 'conflict*', 'tensions', 'NATO', 'Security Council', 'embassy', 'coup', 'election*', 'protest*', 'territorial', 'sovereignty', 'alliance*', 'geopolitic*', 'airstrike*', 'hostage*', 'nuclear talks'], sub: {} }
  ];
  const SECTOR_NAMES = SECTORS.map(s => s.name).concat('Other');

  /* ---------- importance ---------- */
  const IMP_TIERS = [
    { w: 6, terms: ['war', 'invasion', 'invade*', 'nuclear', 'missile*', 'airstrike*', 'coup', 'martial law', 'terror*', 'collapse*', 'default*', 'blockade', 'embargo', 'pandemic', 'bankruptcy', 'insolvency', 'blackout', 'cyberattack*', 'ransomware', 'explosion*', 'assassinat*', 'hostage*', 'casualt*', 'famine', 'meltdown', 'bank run', 'evacuat*'] },
    { w: 3, terms: ['sanction*', 'tariff*', 'export control*', 'export ban*', 'restriction*', 'shortage*', 'disruption*', 'plunge*', 'plummet*', 'soar*', 'surge*', 'spike*', 'record high', 'record low', 'all-time high', 'crash*', 'halt*', 'suspend*', 'probe', 'investigation', 'lawsuit*', 'antitrust', 'downgrade*', 'layoff*', 'job cuts', 'strike*', 'crackdown', 'merger*', 'acquisition*', 'takeover', 'bailout', 'rate cut*', 'rate hike*', 'interest rate*', 'recall*', 'output cut*', 'production cut*', 'price hike*', 'trade deal*', 'trade agreement*', 'trade war', 'ceasefire', 'treaty', 'ban', 'banned', 'ruling', 'fraud', 'scandal', 'breach*', 'outage*', 'crisis', 'crises', 'emergency', 'outbreak', 'reroute*', 'rerouting', 'warn*', 'monetary policy', 'repo rate', 'policy rate', 'rate decision*', 'cut* output', 'cut* production', 'unrest', 'evict*', 'seiz*'] },
    { w: 1, terms: ['announce*', 'launch*', 'approve*', 'plans', 'expects', 'forecast*', 'expansion', 'expand*', 'invest*', 'partnership', 'contract*', 'orders', 'sales', 'results', 'earnings', 'growth', 'profit*', 'revenue', 'guidance', 'quarter*', 'deal*', 'appoint*', 'outlook', 'signs', 'signed', 'unveil*', 'rise', 'rises', 'fall*', 'drop*', 'jump*', 'slump*', 'inflation', 'GDP'], cap: 4 }
  ];
  const LOW_TERMS = ['opinion', 'explainer', 'newsletter', 'weekly roundup', 'webinar', 'advertisement', 'sponsored', 'podcast', 'interview', 'recap', 'roundup'];
  const IMP_ORDER = ['Critical', 'High', 'Medium', 'Low'];
  const impRank = i => 3 - IMP_ORDER.indexOf(i); // Critical=3 … Low=0

  /* ---------- classification ---------- */
  function classifyCountry(text, head, companies, headline) {
    const scores = new Map();
    COUNTRIES.forEach(c => {
      let s = 0;
      c.aliases.forEach(a => {
        const inHead = count(head, a);
        const inBody = count(text, a);
        if (inHead) s += 3;
        s += Math.min(inBody, 4);
      });
      if (s) scores.set(c.name, s);
    });
    companies.forEach(co => {
      const n = COUNTRY_BY_CODE[co.code];
      if (n) scores.set(n, (scores.get(n) || 0) + 1);
    });
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const strong = ranked.filter(r => r[1] >= 2);
    const hl = headline || head.split('\n')[0];
    const globalCue = GLOBAL_CUES.some(g => count(head, g) > 0 || count(text, g) > 1);
    const globalInHeadline = GLOBAL_CUES.some(g => count(hl, g) > 0);
    const inHl = ranked.filter(r => COUNTRY_BY_NAME[r[0]].aliases.some(a => count(hl, a) > 0)).map(r => r[0]);
    let primary;
    if (!ranked.length) primary = 'Global';
    else if (globalInHeadline) primary = 'Global';
    else if (inHl.length === 1) primary = inHl[0];
    else if (inHl.length >= 4 || (strong.length >= 4 && ranked[0][1] < ranked[1][1] * 2) || (globalCue && ranked[0][1] < 5)) primary = 'Global';
    else primary = ranked[0][0];
    const involved = ranked.filter(r => r[0] !== primary && r[1] >= 2).slice(0, 5).map(r => r[0]);
    if (primary === 'Global' && ranked.length) {
      return { primary, involved: ranked.filter(r => r[1] >= 2).slice(0, 5).map(r => r[0]) };
    }
    return { primary, involved };
  }

  function classifySector(text, head, companies) {
    const scores = SECTORS.map(sec => {
      let s = 0;
      sec.kw.forEach(k => {
        if (count(head, k)) s += 3;
        s += Math.min(count(text, k), 3);
      });
      companies.forEach(co => { if (co.sector === sec.name) s += 3; });
      return s;
    });
    let bi = -1, best = 0;
    scores.forEach((s, i) => { if (s > best) { best = s; bi = i; } });
    if (bi < 0 || best < 3) return { sector: 'Other', subsector: '', also: [] };
    const sec = SECTORS[bi];
    let sub = '', subBest = 0;
    Object.entries(sec.sub).forEach(([name, kws]) => {
      let s = 0;
      kws.forEach(k => { if (count(head, k)) s += 3; s += Math.min(count(text, k), 3); });
      if (s > subBest) { subBest = s; sub = name; }
    });
    const also = scores.map((s, i) => [SECTORS[i].name, s]).filter(x => x[0] !== sec.name && x[1] >= Math.max(3, best * 0.6))
      .sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]);
    return { sector: sec.name, subsector: subBest >= 1 ? sub : '', also };
  }

  function classifyImportance(text, head, spread) {
    const body = text.slice(0, 4000);
    let score = 0, critPts = 0;
    const signals = [];
    IMP_TIERS.forEach(t => {
      let tierPts = 0;
      t.terms.forEach(term => {
        const inHead = count(head, term) > 0;
        const inBody = inHead || count(body, term) > 0;
        if (!inBody) return;
        tierPts += t.w * (inHead ? 2 : 1);
        if (t.w >= 3 && signals.length < 6) signals.push(term.replace(/\*/g, '').replace(/^cs:/, ''));
      });
      if (t.w === 6) critPts = tierPts;
      score += t.cap ? Math.min(tierPts, t.cap) : tierPts;
    });
    LOW_TERMS.forEach(term => { if (count(head, term) > 0) score -= 3; });
    if (spread >= 3) score += 2;
    // Critical needs a critical-tier term in the headline (or two in the body), or an extreme total
    const level = (critPts >= 12 || score >= 28) ? 'Critical' : score >= 5 ? 'High' : score >= 2 ? 'Medium' : 'Low';
    return { importance: level, score, signals };
  }

  function findCompanies(text) {
    const found = [];
    COMPANIES.forEach(co => {
      if (co.aliases.some(a => new RegExp('(?<![A-Za-z0-9_])' + escRe(a) + '(?![A-Za-z0-9_])').test(text))) found.push(co);
    });
    return found.slice(0, 8);
  }

  /* ---------- headline, summary, dates ---------- */
  function cleanLine(s) {
    return s.replace(/https?:\/\/\S+/g, '')
      .replace(/[\p{Extended_Pictographic}\uFE0F\u200d]/gu, '')
      .replace(/^[\s\-\u2013\u2014\u2022\u00b7*#>|]+/, '')
      .replace(/^(breaking|just in|alert|update|exclusive|flash|news)\s*[:\-\u2013\u2014|]\s*/i, '')
      .replace(/[*_`~]+/g, '')
      .replace(/\s+/g, ' ').trim();
  }
  function clip(s, n) {
    if (s.length <= n) return s;
    const cut = s.slice(0, n - 1);
    return cut.slice(0, Math.max(cut.lastIndexOf(' '), n * 0.6)).replace(/[,;:\-\u2013\u2014]+$/, '') + '\u2026';
  }
  function pickHeadline(text, fallback) {
    const lines = text.split(/\n+/).map(cleanLine).filter(Boolean);
    for (const l of lines.slice(0, 25)) {
      if (l.length < 18 || !/[A-Za-z]{3}/.test(l)) continue;
      if (/^(page\s*\d+|\d+\s*(of|\/)\s*\d+|table of contents|contents|confidential|disclaimer|research|report)$/i.test(l)) continue;
      const first = l.split(/(?<=[.!?])\s+(?=[A-Z0-9"\u201c'(])/)[0];
      if (l.length > 100 && first.length >= 25 && first.length < l.length) return clip(first.replace(/[.\s]+$/, ''), 160);
      if (l.length > 170) return clip(l, 160);
      return l.replace(/[.\s]+$/, '');
    }
    return clip(cleanLine(text) || fallback || 'Untitled item', 160);
  }
  function sentences(text) {
    const out = [];
    text.split(/\n+/).forEach(line => {
      line = line.trim();
      if (!line) return;
      line.split(/(?<=[.!?])\s+(?=[A-Z0-9"\u201c'(])/).forEach(s => {
        s = cleanLine(s);
        if (s.length >= 30) out.push(s.length > 380 ? clip(s, 380) : s);
      });
    });
    return out;
  }
  function reflow(text) {
    // join hard-wrapped PDF lines; keep short lines (headings) separate
    return text.replace(/([^\n]{50,}[^.!?:;\n\s])[ \t]*\n(?!\n)/g, '$1 ');
  }
  function summarise(text, headline) {
    const hk = headline.slice(0, 40).toLowerCase();
    const sents = sentences(text).filter(s => !s.toLowerCase().startsWith(hk));
    if (!sents.length) {
      const one = cleanLine(text);
      return { summary: one.toLowerCase().startsWith(hk) && one.length <= headline.length + 25 ? '' : clip(one, 320), facts: [] };
    }
    const toks = tokens(text);
    const freq = new Map();
    toks.forEach(t => freq.set(t, (freq.get(t) || 0) + 1));
    const scored = sents.map((s, i) => {
      const st = tokens(s);
      let sc = st.reduce((a, t) => a + (freq.get(t) || 0), 0) / Math.sqrt(st.length || 1);
      if (i < 3) sc *= 1.25 - i * 0.08;
      if (/\d/.test(s)) sc *= 1.1;
      if (s.length < 60) sc *= 0.8;
      return { s, i, sc };
    });
    const total = text.length;
    const take = total < 500 ? 2 : 3;
    const chosen = scored.slice().sort((a, b) => b.sc - a.sc).slice(0, take).sort((a, b) => a.i - b.i);
    let summary = '';
    chosen.forEach(c => { if ((summary + ' ' + c.s).length <= 560) summary = (summary + ' ' + c.s).trim(); });
    if (!summary) summary = chosen[0].s;
    const inSummary = new Set(chosen.map(c => c.i));
    const facts = scored.filter(c => !inSummary.has(c.i) && /(\d+(\.\d+)?\s?(%|percent|per cent|bn|billion|million|crore|lakh|tonnes|basis points|bps))|[$\u20ac\u00a3\u20b9]\s?\d/i.test(c.s))
      .slice(0, 3).map(c => clip(c.s, 220));
    return { summary, facts };
  }

  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  function findDate(text) {
    const t = text.slice(0, 800);
    let m;
    const iso = d => (d.getFullYear() > 2000 && d.getFullYear() < 2100 && !isNaN(d)) ? d.toISOString().slice(0, 10) : null;
    if ((m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) return iso(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
    if ((m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i)))
      return iso(new Date(Date.UTC(+m[3], MONTHS.indexOf(m[2].toLowerCase()), +m[1])));
    if ((m = t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i)))
      return iso(new Date(Date.UTC(+m[3], MONTHS.indexOf(m[1].toLowerCase()), +m[2])));
    return null;
  }

  /* ---------- analyse one document ---------- */
  function analyze(raw, opts) {
    opts = opts || {};
    const isPDF = !!opts.pdf;
    const text = (isPDF ? reflow(raw) : raw).replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
    const headline = cleanLine(opts.headline || '') ? clip(cleanLine(opts.headline), 350) : pickHeadline(raw.replace(/\r/g, ''), opts.fallbackTitle);
    const head = (headline + '\n' + text.slice(0, 300));
    const companies = findCompanies(text);
    const c = classifyCountry(text, head, companies, headline);
    const s = classifySector(text, head, companies);
    const spread = (c.primary === 'Global' ? 1 : 0) + c.involved.length + (c.primary === 'Global' ? 0 : 1);
    const imp = classifyImportance(text, head, spread);
    const sm = summarise(text, headline);
    const toks = tokens(text);
    const headToks = tokens(head);
    const cn = COUNTRY_BY_NAME[c.primary] || COUNTRY_BY_NAME['Global'];
    return {
      headline,
      summary: sm.summary,
      facts: sm.facts,
      country: c.primary, countryCode: cn.code, involved: c.involved,
      sector: s.sector, subsector: s.subsector, also: s.also,
      importance: imp.importance, importanceScore: imp.score, signals: imp.signals,
      companies: companies.map(x => x.name),
      date: opts.date || findDate(text),
      text: text.slice(0, 6000),
      len: text.length,
      hash: hash(toks.slice(0, 400).join(' ')),
      head: [...new Set(headToks)].slice(0, 45),
      key: topTerms(toks, 40)
    };
  }

  /* ---------- duplicate and related-story detection ---------- */
  const setOf = arr => new Set(arr);
  const inter = (a, b) => { let n = 0; a.forEach(x => { if (b.has(x)) n++; }); return n; };
  function compare(a, b) {
    // a, b: { hash, len, country, involved, sector, head:Set, key:Set }
    if (a.hash === b.hash) return { type: 'duplicate', sim: 1 };
    const shHead = inter(a.head, b.head);
    const jh = shHead / ((a.head.size + b.head.size - shHead) || 1);
    const ovHead = shHead / (Math.min(a.head.size, b.head.size) || 1);
    const shKey = inter(a.key, b.key);
    const ovKey = shKey / (Math.min(a.key.size, b.key.size) || 1);
    const lenRatio = Math.min(a.len, b.len) / (Math.max(a.len, b.len) || 1);
    if (jh >= 0.55 || (ovHead >= 0.8 && shHead >= 6 && lenRatio >= 0.6) || (ovKey >= 0.85 && shKey >= 10 && lenRatio >= 0.7))
      return { type: 'duplicate', sim: Math.max(jh, ovHead) };
    const sameCountry = a.country === b.country || a.involved.includes(b.country) || b.involved.includes(a.country);
    if (ovKey >= 0.4 && shKey >= 5 && (sameCountry || a.sector === b.sector)) return { type: 'related', sim: ovKey };
    return null;
  }

  /* ---------- splitting and CSV ---------- */
  function splitMessages(text, byParagraph) {
    const norm = text.replace(/\r/g, '');
    let parts = norm.split(/\n[ \t]*(?:-{3,}|={3,}|\*{3,}|_{3,})[ \t]*\n/);
    if (byParagraph && parts.length === 1) parts = norm.split(/\n\s*\n+/);
    return parts.map(p => p.trim()).filter(p => p.length >= 12);
  }

  function parseCSV(text) {
    const first = text.split(/\r?\n/, 1)[0] || '';
    const delim = [',', ';', '\t'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); cur = '';
        if (row.some(c => c.trim())) rows.push(row);
        row = [];
      } else cur += ch;
    }
    row.push(cur);
    if (row.some(c => c.trim())) rows.push(row);
    return rows;
  }

  function csvToDocs(text, name) {
    const rows = parseCSV(text.replace(/^\uFEFF/, ''));
    if (!rows.length) return [];
    const hdr = rows[0].map(h => h.trim().toLowerCase());
    const find = re => hdr.findIndex(h => re.test(h));
    const iHead = find(/^(headline|title|heading|subject)$/);
    const iBody = find(/^(text|body|content|summary|description|message|article|details|story)$/);
    const iDate = find(/date|published|time/);
    const iSrc = find(/^(source|publisher|channel|outlet)$/);
    const hasHeader = iHead >= 0 || iBody >= 0;
    const data = hasHeader ? rows.slice(1) : rows;
    return data.slice(0, 500).map((r, n) => {
      const cells = r.map(c => c.trim());
      let headline = iHead >= 0 ? cells[iHead] : '';
      let body = iBody >= 0 ? cells[iBody] : '';
      if (!headline && !body) {
        const long = cells.slice().sort((a, b) => b.length - a.length)[0] || '';
        body = long; headline = cells.find(c => c.length >= 12) || '';
      }
      const t = (headline && body && body !== headline) ? headline + '\n' + body : (body || headline);
      let date = null;
      if (iDate >= 0) { const d = new Date(cells[iDate]); if (!isNaN(d) && d.getFullYear() > 2000) date = d.toISOString().slice(0, 10); }
      return { text: t, headline: headline && headline.length >= 12 ? headline : '', date, source: (iSrc >= 0 && cells[iSrc]) ? cells[iSrc] : name + ' (row ' + (n + 1) + ')' };
    }).filter(d => d.text && d.text.length >= 12);
  }

  function toCSV(items) {
    const cols = ['date', 'added_at', 'country', 'involved_countries', 'sector', 'subsector', 'importance', 'headline', 'summary', 'companies', 'sources', 'source_count', 'related_stories'];
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [cols.join(',')];
    items.forEach(it => {
      lines.push([
        it.date || new Date(it.addedAt).toISOString().slice(0, 10), new Date(it.addedAt).toISOString(), it.country, (it.involved || []).join('; '),
        it.sector, it.subsector, it.importance, it.headline, it.summary, (it.companies || []).join('; '),
        (it.sources || []).map(s => s.name).join('; '), (it.sources || []).length, (it.related || []).length
      ].map(q).join(','));
    });
    return '\uFEFF' + lines.join('\r\n');
  }

  /* ---------- sample data (illustrative, not real news) ---------- */
  const SAMPLES = [
    'BREAKING: China announces additional export restrictions on semiconductor equipment, tightening controls on advanced lithography tools. The Ministry of Commerce said the measures take effect next month and target chip-making machinery used for advanced nodes.',
    'China tightens semiconductor equipment export controls: what it means for the chip supply chain\nBeijing has widened export controls on semiconductor manufacturing equipment, adding advanced lithography and etching tools to its licensing list. Suppliers including ASML, Applied Materials and Tokyo Electron are expected to review shipments to Chinese fabs. Analysts at several brokerages estimate that equipment orders worth about $4 billion could be delayed over the next two quarters. Taiwan and South Korea, where TSMC and SK Hynix operate large foundry and memory fabs, may face longer lead times for tools and spare parts. The restrictions add to existing US export controls on advanced chips and could push manufacturers to diversify their semiconductor equipment sourcing. Japan is also reviewing its own licensing rules for chip-making machinery. The global chip supply chain remains tight for high-end memory used in AI servers.',
    'China announces new export restrictions on semiconductor equipment. Beijing\'s commerce ministry said controls on advanced lithography tools will take effect next month, targeting chip-making machinery.',
    'Tata Motors reports stronger-than-expected EV sales in August, with electric vehicle registrations up 34% year on year. The company said demand for its electric SUVs stayed strong in India, helped by new charging stations and lower battery costs.',
    'US Federal Reserve cuts interest rates by 25 basis points as inflation eases. Policymakers signalled further rate cuts if the labour market cools, and Wall Street rallied after the decision.',
    'Russia announces new restrictions on oil exports to countries that follow the price cap. Brent crude rose 3% to $91 a barrel as traders priced in tighter supply.',
    'India and the European Union sign a new trade agreement covering textiles, pharmaceuticals and automobiles, cutting tariffs on more than 90% of traded goods. Negotiators from New Delhi and Brussels said the deal should lift bilateral trade over the next five years.',
    'Copper prices climb to a record high after Chinese smelters announce output cuts. Electrical equipment makers warn of price increases, and automotive suppliers flag higher input costs for wiring harnesses and motors.',
    'Global shipping rates surge as Red Sea disruptions force container vessels to reroute around the Cape of Good Hope, lifting freight costs on Asia-Europe routes by 40%.',
    'Israel and Lebanon exchange missile strikes overnight, and Hezbollah claimed responsibility for a barrage on northern towns. Airlines suspended flights and several countries urged citizens to leave.',
    'Weekly newsletter: opinion on consumer spending trends and retail brands, with a roundup of festive season marketing campaigns.'
  ];

  return {
    analyze, compare, setOf, splitMessages, parseCSV, csvToDocs, toCSV, tokens, flag,
    classifyCountry, classifySector, classifyImportance, findCompanies, findDate,
    COUNTRY_NAMES, COUNTRY_BY_NAME, SECTOR_NAMES, IMP_ORDER, impRank, SAMPLES, clip
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Engine;

/* ================= Part 2: interface ================= */
if (typeof document !== 'undefined') (function () {
  const E = Engine;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const URLS = {
    pdfjs: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
  };
  const MAX_PDF_PAGES = 80;

  const S = {
    items: [],
    live: [],
    liveMeta: null,
    brief: null,
    lastLive: 0,
    files: [],
    tab: 'inbox',
    open: new Set(),
    exportRange: 'today',
    f: { range: '7d', country: '', sector: '', imp: '', q: '', view: 'priority' }
  };

  /* ---------- storage (IndexedDB) ---------- */
  const DB = {
    db: null,
    init() {
      return new Promise(res => {
        try {
          const r = indexedDB.open('gni-phase1', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id' });
          r.onsuccess = () => { DB.db = r.result; res(true); };
          r.onerror = () => res(false);
        } catch (e) { res(false); }
      });
    },
    tx(mode, fn) {
      return new Promise((ok, no) => {
        if (!DB.db) return ok(null);
        const t = DB.db.transaction('items', mode);
        const req = fn(t.objectStore('items'));
        t.oncomplete = () => ok(req ? req.result : null);
        t.onerror = () => no(t.error);
      });
    },
    all() { return DB.tx('readonly', s => s.getAll()).then(r => r || []); },
    put(it) { return DB.tx('readwrite', s => s.put(strip(it))); },
    del(id) { return DB.tx('readwrite', s => s.delete(id)); },
    clear() { return DB.tx('readwrite', s => s.clear()); }
  };
  const strip = it => JSON.parse(JSON.stringify(it));

  /* ---------- helpers ---------- */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3600);
  }
  const tick = () => new Promise(r => setTimeout(r, 0));
  const newId = () => 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dayISO = ts => new Date(ts).toISOString().slice(0, 10);
  function ago(ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    return Math.round(h / 24) + ' d ago';
  }
  const all = () => S.items.concat(S.live);
  const flagOf = name => E.flag((E.COUNTRY_BY_NAME[name] || {}).code);
  const loaded = {};
  function loadScript(src) {
    return loaded[src] || (loaded[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res;
      s.onerror = () => { delete loaded[src]; rej(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    }));
  }
  function inRange(it, range) {
    if (range === 'all') return true;
    if (range === 'today') return new Date(it.addedAt).toDateString() === new Date().toDateString();
    return Date.now() - it.addedAt <= 7 * 864e5;
  }
  const byPriority = (a, b) => E.impRank(b.importance) - E.impRank(a.importance) || b.addedAt - a.addedAt;
  const prep = it => {
    if (!it._p) Object.defineProperty(it, '_p', {
      value: { hash: it.hash, len: it.len, country: it.country, involved: it.involved || [], sector: it.sector, head: new Set(it.head), key: new Set(it.key) },
      writable: true, enumerable: false, configurable: true
    });
    return it._p;
  };

  /* ---------- ingestion ---------- */
  const newStats = () => ({ added: 0, dup: 0, related: 0 });
  const addStats = (a, b) => { a.added += b.added; a.dup += b.dup; a.related += b.related; };

  async function addDoc(doc, st, fresh) {
    const rec = E.analyze(doc.text, { headline: doc.headline, date: doc.date, pdf: doc.pdf, fallbackTitle: doc.fallbackTitle });
    const p = { hash: rec.hash, len: rec.len, country: rec.country, involved: rec.involved, sector: rec.sector, head: new Set(rec.head), key: new Set(rec.key) };
    let dup = null; const rels = [];
    for (const it of S.items) {
      const c = E.compare(p, prep(it));
      if (!c) continue;
      if (c.type === 'duplicate') { if (!dup || c.sim > dup.sim) dup = { it, sim: c.sim }; }
      else rels.push({ it, sim: c.sim });
    }
    if (dup) {
      dup.it.sources.push({ name: doc.source, at: Date.now() });
      await DB.put(dup.it);
      st.dup++;
      return;
    }
    const now = Date.now();
    const item = Object.assign(rec, { id: newId(), addedAt: now, source: doc.source, sources: [{ name: doc.source, at: now }], related: [], manual: false });
    rels.sort((a, b) => b.sim - a.sim).slice(0, 3).forEach(r => {
      item.related.push(r.it.id);
      r.it.related = [...new Set([...(r.it.related || []), item.id])];
      DB.put(r.it);
    });
    if (rels.length) st.related++;
    S.items.push(item);
    await DB.put(item);
    st.added++;
    if (fresh) fresh.push(item);
  }

  async function readPDF(file, onProgress) {
    await loadScript(URLS.pdfjs);
    const lib = window.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = URLS.pdfWorker;
    const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const n = Math.min(pdf.numPages, MAX_PDF_PAGES);
    const pages = [];
    for (let p = 1; p <= n; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const lines = []; let line = '';
      tc.items.forEach(it => { line += it.str; if (it.hasEOL) { lines.push(line); line = ''; } });
      if (line) lines.push(line);
      pages.push(lines.join('\n'));
      if (onProgress) onProgress(p, n);
      if (p % 4 === 0) await tick();
    }
    return { text: pages.join('\n\n'), pages: pdf.numPages, read: n };
  }

  async function handleFile(f, fresh) {
    const st = newStats();
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const byPara = $('#byPara').checked;
    if (ext === 'pdf' || f.type === 'application/pdf') {
      const line = log('Reading ' + f.name + '\u2026');
      let r;
      try { r = await readPDF(f, (p, n) => { line.textContent = 'Reading ' + f.name + ', page ' + p + ' of ' + n + '\u2026'; }); }
      catch (e) {
        line.className = 'err';
        line.textContent = f.name + ': the PDF reader could not load. Connect to the internet once and try again. It is saved for offline use afterwards.';
        return st;
      }
      if (r.text.replace(/\s/g, '').length < 60) {
        line.className = 'warn';
        line.textContent = f.name + ': no selectable text found. Scanned PDFs need OCR, which comes in Phase 2.';
        return st;
      }
      await addDoc({ text: r.text, source: f.name, pdf: true, fallbackTitle: f.name.replace(/\.pdf$/i, '') }, st, fresh);
      line.className = 'ok';
      line.textContent = f.name + ': ' + summariseStats(st) + (r.pages > r.read ? ' (first ' + r.read + ' of ' + r.pages + ' pages read)' : '');
    } else if (['txt', 'md', 'log'].includes(ext) || (f.type || '').startsWith('text/plain')) {
      const t = await f.text();
      let parts = E.splitMessages(t, byPara);
      if (!parts.length && t.trim().length >= 12) parts = [t.trim()];
      for (const [i, p] of parts.entries()) { await addDoc({ text: p, source: f.name }, st, fresh); if (i % 20 === 19) await tick(); }
      log(f.name + ': ' + summariseStats(st), st.added + st.dup ? 'ok' : 'warn');
    } else if (['csv', 'tsv'].includes(ext) || (f.type || '').includes('csv')) {
      const docs = E.csvToDocs(await f.text(), f.name);
      for (const [i, d] of docs.entries()) { await addDoc(d, st, fresh); if (i % 20 === 19) await tick(); }
      log(f.name + ': ' + (docs.length ? summariseStats(st) + ' from ' + docs.length + ' rows' : 'no usable rows found'), docs.length ? 'ok' : 'warn');
    } else {
      log(f.name + ': this file type is not supported yet. Word, Excel and images come in Phase 2.', 'warn');
    }
    return st;
  }
  const summariseStats = st => {
    const bits = [st.added + ' new'];
    if (st.dup) bits.push(st.dup + ' duplicate' + (st.dup > 1 ? 's' : '') + ' merged');
    if (st.related) bits.push(st.related + ' linked to related stories');
    return bits.join(', ');
  };

  function log(msg, cls) {
    const p = document.createElement('p');
    p.textContent = msg; if (cls) p.className = cls;
    $('#log').appendChild(p);
    return p;
  }

  async function runIngest() {
    const pasted = $('#paste').value.trim();
    if (!pasted && !S.files.length) { toast('Paste some text or choose a file first.'); return; }
    const btn = $('#addBtn'); btn.disabled = true;
    $('#log').innerHTML = ''; $('#fresh').innerHTML = '';
    const total = newStats(); const fresh = [];
    try {
      if (pasted) {
        const st = newStats();
        let parts = E.splitMessages(pasted, $('#byPara').checked);
        if (!parts.length && pasted.length >= 12) parts = [pasted];
        if (!parts.length) log('The pasted text is too short to use.', 'warn');
        for (const p of parts) await addDoc({ text: p, source: 'Pasted text' }, st, fresh);
        if (parts.length) log('Pasted text: ' + summariseStats(st), 'ok');
        addStats(total, st);
        $('#paste').value = '';
      }
      for (const f of S.files) addStats(total, await handleFile(f, fresh));
      S.files = []; renderFiles();
    } catch (e) {
      log('Something went wrong: ' + e.message, 'err');
    } finally { btn.disabled = false; }
    renderFresh(fresh);
    renderAll();
    if (total.added + total.dup) toast(summariseStats(total));
  }

  async function loadSample() {
    const st = newStats(); const fresh = [];
    $('#log').innerHTML = '';
    for (const t of E.SAMPLES) await addDoc({ text: t, source: 'Sample data' }, st, fresh);
    log('Sample data: ' + summariseStats(st), 'ok');
    log('These are made-up examples for testing, not real news.', 'warn');
    renderFresh(fresh); renderAll();
    toast(summariseStats(st));
  }

  /* ---------- rendering ---------- */
  function filtered(skip) {
    const f = S.f, q = f.q.trim().toLowerCase();
    return all().filter(it => {
      if (!inRange(it, f.range)) return false;
      if (skip !== 'country' && f.country && it.country !== f.country && !(it.involved || []).includes(f.country)) return false;
      if (skip !== 'sector' && f.sector && it.sector !== f.sector) return false;
      if (skip !== 'imp' && f.imp && it.importance !== f.imp) return false;
      if (q && !(it.headline + ' ' + it.summary + ' ' + it.country + ' ' + it.sector + ' ' + it.subsector + ' ' + (it.companies || []).join(' ') + ' ' + it.text).toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function entryHTML(it) {
    const open = S.open.has(it.id);
    const n = (it.sources || []).length;
    const rel = (it.related || []).length;
    return `<article class="entry imp-${it.importance.toLowerCase()}${open ? ' open' : ''}" data-id="${it.id}">
      <div class="where"><span>${flagOf(it.country)} ${esc(it.country)}</span><span class="sect">${esc(it.sector)}${it.subsector ? ' / ' + esc(it.subsector) : ''}</span></div>
      <h3 class="hl">${esc(it.headline)}</h3>
      ${it.summary ? `<p class="sum">${esc(it.summary)}</p>` : ''}
      <div class="foot"><span class="imp" style="display:none"><i></i>${it.importance}</span>${it.live ? '' : ''}${n > 1 ? `<span>${n} sources</span>` : ''}${rel ? `<span>${rel} related</span>` : ''}<span>${ago(it.addedAt)}</span></div>
      ${open ? detailsHTML(it) : ''}
    </article>`;
  }

  /* ---------- Analyze with AI (headline is the only thing sent) ---------- */
  function aiPrompt(it) {
    return `Analyze this news/event:

${it.headline}

Please explain:
1. What happened?
2. Why is it important?
3. What could be the impact?
4. Which countries, industries and companies could be affected?
5. What should be monitored next?`;
  }

  function aiLinks(it) {
    return `<div class="ai-actions">
      <b>Analyze with AI</b>
      <div class="ai-buttons">
        <button class="btn-ai-img" data-act="ai" data-ai="chatgpt" data-id="${it.id}" title="Analyze with ChatGPT">
          <img src="data:image/jpeg;base64,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" alt="ChatGPT" class="ai-img"/>
        </button>
        <button class="btn-ai-img" data-act="ai" data-ai="claude" data-id="${it.id}" title="Analyze with Claude">
          <img src="data:image/png;base64,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" alt="Claude" class="ai-img"/>
        </button>
      </div>
    </div>`;
  }

  function openAI(it, provider) {
    const prompt = encodeURIComponent(aiPrompt(it));
    const urls = {
      chatgpt: 'https://chatgpt.com/?q=' + prompt,
      claude: 'https://claude.ai/new?q=' + prompt
    };
    const url = urls[provider];
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }

  function detailsHTML(it) {
    const rel = (it.related || []).map(id => all().find(x => x.id === id)).filter(Boolean);
    const opt = (list, cur) => list.map(v => `<option${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
    const row = (k, v) => v ? `<dt>${k}</dt><dd>${v}</dd>` : '';
    return `<div class="details">
      ${aiLinks(it)}
      ${it.why ? `<p class="why"><b>Why it matters</b> ${esc(it.why)}</p>` : ''}
      ${(it.facts || []).length ? `<ul class="facts">${it.facts.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
      <dl class="kv">
        ${row('Also involved', (it.involved || []).map(c => flagOf(c) + ' ' + esc(c)).join(', '))}
        ${row('Companies', (it.companies || []).map(esc).join(', '))}
        ${row('Also touches', (it.also || []).map(esc).join(', ')) ? '' : ''} <!-- hidden -->
        ${row('Rating signals', (it.signals || []).map(esc).join(', ')) ? '' : ''} <!-- hidden -->
        ${row('Source date', esc(it.date || dayISO(it.addedAt)))}
        ${row('Sources', (it.sources || []).map(s => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)).join(', '))}
      </dl>
      ${rel.length ? `<div class="rel"><b>Related stories</b>${rel.map(r => `<button class="link" data-act="goto" data-id="${r.id}">${flagOf(r.country)} ${esc(r.headline)}</button>`).join('')}</div>` : ''}
      ${it.live ? '<p class="muted" style="margin:0;display:none">' + (it.rules ? 'Sorted by keyword rules from a short excerpt. Live items cannot be edited here.' : 'Live stories are written by the AI pipeline and cannot be edited here.') + '</p>' : `<div class="edit">
        <label>Country<select data-edit="country">${opt(E.COUNTRY_NAMES, it.country)}</select></label>
        <label>Sector<select data-edit="sector">${opt(E.SECTOR_NAMES, it.sector)}</select></label>
        <label>Importance<select data-edit="importance">${opt(E.IMP_ORDER, it.importance)}</select></label>
      </div>
      <button class="btn small danger" data-act="del" data-id="${it.id}">Delete item</button>`}
    </div>`;
  }

  const IMP_TITLES = { Critical: 'Critical developments', High: 'High priority', Medium: 'Medium priority', Low: 'Low priority' };
  const IMP_VAR = { Critical: 'var(--crit)', High: 'var(--high)', Medium: 'var(--med)', Low: 'var(--low)' };

  function groupHead(html, n, color) {
    return `<h2 class="grp">${color ? `<span class="sw" style="background:${color}"></span>` : ''}${html}<span class="n">${n}</span></h2>`;
  }

  function renderList() {
    const items = filtered().sort(byPriority);
    const box = $('#list');
    if (!all().length) {
      box.innerHTML = `<div class="empty"><p>Nothing in the briefing yet.</p><p>Add a message or file in the Inbox, or load sample data to see how it works.</p><button class="btn primary" data-act="sample">Load sample data</button></div>`;
      return;
    }
    if (!items.length) {
      box.innerHTML = `<div class="empty"><p>No items match these filters.</p><button class="btn" data-act="reset">Clear filters</button></div>`;
      return;
    }
    let html = '';
    if (S.f.view === 'priority') {
      E.IMP_ORDER.forEach(lv => {
        const g = items.filter(i => i.importance === lv);
        if (g.length) html += groupHead(IMP_TITLES[lv], g.length, IMP_VAR[lv]) + g.map(entryHTML).join('');
      });
    } else {
      const key = S.f.view === 'country' ? 'country' : 'sector';
      const map = new Map();
      items.forEach(i => { if (!map.has(i[key])) map.set(i[key], []); map.get(i[key]).push(i); });
      [...map.entries()].sort((a, b) => E.impRank(b[1][0].importance) - E.impRank(a[1][0].importance) || b[1].length - a[1].length)
        .forEach(([k, g]) => { html += groupHead((key === 'country' ? flagOf(k) + ' ' : '') + esc(k), g.length) + g.map(entryHTML).join(''); });
    }
    box.innerHTML = html;
  }


  function renderCountrySectorSelectors() {
    const countries = [...new Set(all().map(i => i.country))].sort();
    const sectors = [...new Set(all().map(i => i.sector))].sort();
    
    const countryHtml = `<select id="countryFilter" class="filter-dropdown">
      <option value="">All Countries</option>
      ${countries.map(c => `<option value="${c}" ${S.f.country === c ? 'selected' : ''}>${c}</option>`).join('')}
    </select>`;
    
    const sectorHtml = `<select id="sectorFilter" class="filter-dropdown">
      <option value="">All Sectors</option>
      ${sectors.map(s => `<option value="${s}" ${S.f.sector === s ? 'selected' : ''}>${s}</option>`).join('')}
    </select>`;
    
    const filterBox = $('#filterDropdowns');
    if (filterBox) {
      filterBox.innerHTML = `<div class="filter-selectors">${countryHtml}${sectorHtml}</div>`;
      document.getElementById('countryFilter')?.addEventListener('change', (e) => {
        S.f.country = e.target.value;
        renderControls(); renderList();
      });
      document.getElementById('sectorFilter')?.addEventListener('change', (e) => {
        S.f.sector = e.target.value;
        renderControls(); renderList();
      });
    }
  }

  function renderControls() {
    // Hidden: live feed info, range selector, and importance chips are now minimized
    // Only render country/sector dropdowns
    renderCountrySectorSelectors();
    // country strip
    const cBase = filtered('country'); const cm = new Map();
    cBase.forEach(i => { [i.country].concat(i.involved || []).forEach(c => cm.set(c, (cm.get(c) || 0) + 1)); });
    $('#countries').innerHTML = [...cm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
      .map(([c, n]) => `<button class="chip${S.f.country === c ? ' on' : ''}" data-act="fc" data-v="${esc(c)}">${flagOf(c)} ${esc(c)} <b>${n}</b></button>`).join('');
    // sector strip
    const sBase = filtered('sector'); const sm = new Map();
    sBase.forEach(i => sm.set(i.sector, (sm.get(i.sector) || 0) + 1));
    $('#sectors').innerHTML = [...sm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
      .map(([s, n]) => `<button class="chip${S.f.sector === s ? ' on' : ''}" data-act="fs" data-v="${esc(s)}">${esc(s)} <b>${n}</b></button>`).join('');
    // segmented controls
    $$('#rangeSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === S.f.range));
    $$('#viewSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === S.f.view));
    const shown = filtered();
    const merged = shown.reduce((a, i) => a + Math.max(0, (i.sources || []).length - 1), 0);
    $('#briefMeta').textContent = shown.length + (shown.length === 1 ? ' item' : ' items') + (merged ? ', ' + merged + ' duplicate' + (merged > 1 ? 's' : '') + ' merged' : '');
    $('#hasFilter').hidden = !(S.f.country || S.f.sector || S.f.imp || S.f.q);
  }

  function renderFresh(fresh) {
    $('#fresh').innerHTML = fresh.length ? `<h2 class="grp">Just added${'<span class="n">' + fresh.length + '</span>'}</h2>` + fresh.slice().sort(byPriority).slice(0, 12).map(entryHTML).join('') : '';
  }
  function renderFiles() {
    $('#fileChips').innerHTML = S.files.map((f, i) => `<span class="fchip">${esc(f.name)}<button aria-label="Remove ${esc(f.name)}" data-act="rmfile" data-i="${i}">\u00d7</button></span>`).join('');
  }
  async function renderExport() {
    const n = S.items.length;
    $('#storeInfo').textContent = n + (n === 1 ? ' item you added is' : ' items you added are') + ' stored on this phone and never uploaded. ' + S.live.length + ' live stories come from the feed.';
    $$('#exportSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === S.exportRange));
    const c = all().filter(i => inRange(i, S.exportRange)).length;
    $('#exportCount').textContent = c + (c === 1 ? ' item' : ' items') + ' in this period';
  }
  function renderAll() {
    renderControls(); renderList(); renderExport();
    // keep the just-added cards in sync when they are toggled
  }

  /* ---------- tabs ---------- */
  function setTab(name) {
    S.tab = name;
    $$('.view').forEach(v => v.hidden = v.id !== 'view-' + name);
    $$('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === name));
    if (name !== 'inbox' || true) window.scrollTo(0, 0);
    if (name === 'brief') { renderControls(); renderList(); }
    if (name === 'export') renderExport();
  }

  /* ---------- export ---------- */
  function download(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  const RANGE_LABEL = { today: 'Today', '7d': 'Last 7 days', all: 'All items' };

  function exportCSV() {
    const items = all().filter(i => inRange(i, S.exportRange)).sort(byPriority);
    if (!items.length) { toast('Nothing to export for that period.'); return; }
    download('global-intelligence-' + dayISO(Date.now()) + '.csv', E.toCSV(items), 'text/csv;charset=utf-8');
    toast('CSV saved to Downloads.');
  }

  async function exportPDF() {
    const items = all().filter(i => inRange(i, S.exportRange)).sort(byPriority);
    if (!items.length) { toast('Nothing to export for that period.'); return; }
    toast('Building the PDF\u2026');
    try { await loadScript(URLS.jspdf); }
    catch (e) { toast('The PDF tool could not load. Connect to the internet once and try again.'); return; }
    const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
    const PW = doc.internal.pageSize.getWidth(), PH = doc.internal.pageSize.getHeight(), M = 42, CW = PW - 2 * M;
    let y = 0;
    const safe = t => String(t || '').replace(/[\u2018\u2019\u201B]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-')
      .replace(/\u2026/g, '...').replace(/[\u2022\u00b7]/g, '-').replace(/\u00a0/g, ' ').replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '');
    const COL = { Critical: [200, 50, 31], High: [207, 127, 18], Medium: [79, 124, 163], Low: [135, 149, 162] };
    const INK = [14, 34, 56], GREY = [88, 104, 120];
    const need = h => { if (y + h > PH - 46) { doc.addPage(); y = M; } };
    function put(t, o) {
      o = Object.assign({ size: 10, bold: false, color: INK, after: 4, indent: 0 }, o);
      doc.setFont('helvetica', o.bold ? 'bold' : 'normal'); doc.setFontSize(o.size); doc.setTextColor(...o.color);
      const lh = o.size * 1.34;
      doc.splitTextToSize(safe(t), CW - o.indent).forEach(l => { need(lh); doc.text(l, M + o.indent, y + o.size); y += lh; });
      y += o.after;
    }
    function heading(t) {
      need(40); y += 6;
      put(t, { size: 13, bold: true, after: 3 });
      doc.setDrawColor(...INK); doc.setLineWidth(0.8); doc.line(M, y, PW - M, y); y += 10;
    }

    // masthead
    doc.setFillColor(...INK); doc.rect(0, 0, PW, 92, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(23); doc.text('Global Intelligence Report', M, 44);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5);
    doc.text(new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + '   |   ' + RANGE_LABEL[S.exportRange], M, 64);
    y = 116;
    const cnt = {}; E.IMP_ORDER.forEach(l => cnt[l] = items.filter(i => i.importance === l).length);
    const dups = items.reduce((a, i) => a + Math.max(0, (i.sources || []).length - 1), 0);
    put(items.length + ' developments: ' + E.IMP_ORDER.map(l => cnt[l] + ' ' + l.toLowerCase()).join(', ') + (dups ? '. ' + dups + ' duplicate report' + (dups > 1 ? 's' : '') + ' merged.' : '.'), { size: 10, color: GREY, after: 8 });

    const top = items.filter(i => i.importance === 'Critical' || i.importance === 'High');
    if (top.length) {
      heading('Priority developments');
      top.forEach(it => {
        need(70);
        doc.setFillColor(...COL[it.importance]); doc.rect(M, y + 2, 7, 9, 'F');
        put(it.headline, { size: 11.5, bold: true, indent: 14, after: 1 });
        put(it.country + '  |  ' + it.sector + (it.subsector ? ' / ' + it.subsector : '') + '  |  ' + it.importance + ((it.sources || []).length > 1 ? '  |  ' + it.sources.length + ' sources' : ''), { size: 8.5, color: GREY, indent: 14, after: 2 });
        if (it.summary) put(it.summary, { size: 9.5, indent: 14, after: 9 }); else y += 7;
      });
    }

    heading('All developments by country');
    const map = new Map();
    items.forEach(i => { if (!map.has(i.country)) map.set(i.country, []); map.get(i.country).push(i); });
    [...map.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([c, g]) => {
      need(40);
      put(c + ' (' + g.length + ')', { size: 11, bold: true, after: 2 });
      g.forEach(it => put('- ' + it.headline + '  [' + it.sector + ', ' + it.importance + ']', { size: 9.2, indent: 8, after: 2 }));
      y += 5;
    });

    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(120, 130, 140);
      doc.text('Global News Intelligence, generated on device   |   page ' + p + ' of ' + pages, PW / 2, PH - 22, { align: 'center' });
    }
    doc.save('Global-Intelligence-' + dayISO(Date.now()) + '.pdf');
    toast('PDF saved to Downloads.');
  }

  /* ---------- events ---------- */
  document.addEventListener('click', async ev => {
    const el = ev.target.closest('[data-act],[data-tab],[data-v]');
    if (el && el.dataset.tab) { setTab(el.dataset.tab); return; }
    if (el && el.closest('#rangeSeg')) { S.f.range = el.dataset.v; renderControls(); renderList(); return; }
    if (el && el.closest('#viewSeg')) { S.f.view = el.dataset.v; renderControls(); renderList(); return; }
    if (el && el.closest('#exportSeg')) { S.exportRange = el.dataset.v; renderExport(); return; }
    const act = el && el.dataset.act;
    if (act) {
      const v = el.dataset.v;
      if (act === 'ai') {
        const it = all().find(x => x.id === el.dataset.id);
        if (it) openAI(it, el.dataset.ai);
      }
      else if (act === 'fi') { S.f.imp = v; renderControls(); renderList(); }
      else if (act === 'fc') { S.f.country = S.f.country === v ? '' : v; renderControls(); renderList(); }
      else if (act === 'fs') { S.f.sector = S.f.sector === v ? '' : v; renderControls(); renderList(); }
      else if (act === 'reset') { S.f = Object.assign(S.f, { country: '', sector: '', imp: '', q: '', range: 'all' }); $('#q').value = ''; renderControls(); renderList(); }
      else if (act === 'sample') { await loadSample(); setTab('brief'); }
      else if (act === 'refresh') { await loadLive(true); }
      else if (act === 'rmfile') { S.files.splice(+el.dataset.i, 1); renderFiles(); }
      else if (act === 'goto') {
        const id = el.dataset.id;
        S.f = Object.assign(S.f, { country: '', sector: '', imp: '', q: '', range: 'all' }); $('#q').value = '';
        S.open.add(id);
        if (S.tab !== 'brief') setTab('brief');
        renderControls(); renderList();
        const t = document.querySelector('#view-brief .entry[data-id="' + id + '"]');
        if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      else if (act === 'del') {
        if (!confirm('Delete this item?')) return;
        const id = el.dataset.id;
        S.items = S.items.filter(i => i.id !== id);
        for (const i of S.items) if ((i.related || []).includes(id)) { i.related = i.related.filter(r => r !== id); await DB.put(i); }
        await DB.del(id); S.open.delete(id);
        renderAll(); renderFresh([]);
      }
      return;
    }
    // tap on an entry toggles its details
    const card = ev.target.closest('.entry');
    if (card && !ev.target.closest('select,button,a,label')) {
      const id = card.dataset.id;
      if (S.open.has(id)) S.open.delete(id); else S.open.add(id);
      const it = all().find(i => i.id === id);
      if (it) card.outerHTML = entryHTML(it);
    }
  });

  document.addEventListener('change', async ev => {
    const sel = ev.target.closest('select[data-edit]');
    if (!sel) return;
    const card = sel.closest('.entry');
    const it = S.items.find(i => i.id === card.dataset.id);
    if (!it) return;
    const f = sel.dataset.edit;
    it[f] = sel.value;
    if (f === 'country') { it.countryCode = (E.COUNTRY_BY_NAME[sel.value] || {}).code || 'GL'; it.involved = (it.involved || []).filter(c => c !== sel.value); }
    it.manual = true; it._p = undefined;
    await DB.put(it);
    renderControls(); renderList(); renderExport();
    toast('Updated.');
  });

  $('#files').addEventListener('change', e => {
    S.files.push(...e.target.files); e.target.value = ''; renderFiles();
  });
  $('#addBtn').addEventListener('click', runIngest);
  $('#q').addEventListener('input', e => { S.f.q = e.target.value; renderControls(); renderList(); });
  $('#pdfBtn').addEventListener('click', exportPDF);
  $('#csvBtn').addEventListener('click', exportCSV);
  $('#clearBtn').addEventListener('click', async () => {
    if (!S.items.length) { toast('There is nothing to clear.'); return; }
    if (!confirm('Delete the ' + S.items.length + ' items you added on this phone? Live stories are not affected. This cannot be undone.')) return;
    await DB.clear(); S.items = []; S.open.clear(); $('#fresh').innerHTML = ''; renderAll(); toast('All data cleared.');
  });


  /* ---------- live feed and AI briefing (Phase 2) ---------- */
  const REPO = 'romitrajput/QwickSignal', BRANCH = 'main';
  async function getJSON(name) {
    const urls = ['https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/' + name, name];
    for (const u of urls) {
      try {
        const r = await fetch(u + '?t=' + Date.now(), { cache: 'no-store' });
        if (r.ok) return await r.json();
      } catch (e) { /* try the next address */ }
    }
    return null;
  }
  function mapRules(x) {
    // free mode: the pipeline saved only an excerpt, so this phone sorts it with the keyword rules
    const t = Date.parse(x.published) || Date.now();
    const r = E.analyze(x.excerpt || x.headline, { headline: x.headline, date: (x.published || '').slice(0, 10) });
    return {
      id: 'L' + x.id, live: true, rules: true, headline: x.headline || r.headline, summary: r.summary || '', why: '',
      country: r.country, countryCode: r.countryCode, involved: r.involved, sector: r.sector, subsector: r.subsector,
      also: r.also, signals: r.signals, importance: r.importance, companies: r.companies, facts: r.facts,
      date: (x.published || '').slice(0, 10), text: x.excerpt || '', addedAt: t,
      sources: (x.sources || []).map(s => ({ name: s.name, url: s.url, at: Date.parse(s.at) || t })), related: []
    };
  }
  function mapLive(x) {
    if (x.ai === false) return mapRules(x);
    const t = Date.parse(x.published) || Date.now();
    const c = E.COUNTRY_BY_NAME[x.country] ? x.country : 'Global';
    return {
      id: 'L' + x.id, live: true, headline: x.headline || '', summary: x.summary || '', why: x.why_it_matters || '',
      country: c, countryCode: E.COUNTRY_BY_NAME[c].code, involved: x.involved || [],
      sector: E.SECTOR_NAMES.includes(x.sector) ? x.sector : 'Other', subsector: x.subsector || '', also: [], signals: [],
      importance: E.IMP_ORDER.includes(x.importance) ? x.importance : 'Medium',
      companies: x.companies || [], facts: x.facts || [], date: (x.published || '').slice(0, 10),
      text: (x.summary || '') + ' ' + (x.why_it_matters || ''), addedAt: t,
      sources: (x.sources || []).map(s => ({ name: s.name, url: s.url, at: Date.parse(s.at) || t })),
      related: (x.related || []).map(r => 'L' + r)
    };
  }
  const readCache = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const writeCache = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full */ } };

  async function loadLive(manual) {
    if (manual) $('#liveBar').querySelector('span').textContent = 'Refreshing\u2026';
    let [feed, brief] = await Promise.all([getJSON('feed.json'), getJSON('briefing.json')]);
    let cached = false;
    if (feed && Array.isArray(feed.items)) writeCache('gni-feed', feed);
    else { feed = readCache('gni-feed'); cached = !!feed; }
    if (brief && brief.overview) writeCache('gni-brief', brief); else brief = readCache('gni-brief');
    S.live = feed && Array.isArray(feed.items) ? feed.items.map(mapLive) : [];
    S.liveMeta = feed ? { at: Date.parse(feed.generated_at) || 0, cached } : null;
    S.brief = brief;
    S.lastLive = Date.now();
    renderLiveBar(manual);
    renderAll(); renderBrief();
    if (manual) toast(S.liveMeta ? S.live.length + ' live stories loaded.' : 'The live feed is not set up yet.');
  }
  function renderLiveBar() {
    const m = S.liveMeta;
    $('#liveBar').innerHTML = (m
      ? `<span>${S.live.length} live stories${m.at ? ', updated ' + ago(m.at) : ''}${S.live.some(i => i.rules) ? ', free mode (no AI)' : ''}${m.cached ? ' (saved copy, you are offline)' : ''}</span>`
      : '<span>Live feed not connected yet</span>') + '<button class="link inline" data-act="refresh">Refresh</button>';
  }
  function renderBrief() {
    const b = S.brief, box = $('#aiBrief');
    if (!b) { box.innerHTML = ''; return; }
    const item = id => S.live.find(i => i.id === 'L' + id);
    const flags = cs => (cs || []).map(c => flagOf(c)).join(' ');
    const crit = (b.critical || []).map(c => ({ it: item(c.item_id), note: c.note })).filter(c => c.it);
    const themes = (b.themes || []).map(t => `<li><b>${esc(t.title)}</b> <span class="fl">${flags(t.countries)}</span>
        <p>${esc(t.what_changed)}</p>${t.watch_next ? `<p class="next">Watch next: ${esc(t.watch_next)}</p>` : ''}</li>`).join('');
    const chains = (b.impact_chains || []).map(c => `<li><b>${esc(c.title)}</b> <span class="conf">${esc(c.confidence)} confidence</span>
        <ol class="chain">${(c.steps || []).map(s => `<li>${esc(s)}</li>`).join('')}</ol></li>`).join('');
    const watch = (b.watchlist || []).map(w => `<li>${esc(w)}</li>`).join('');
    box.innerHTML = `<section class="ai">
      <div class="aihead"><h2>AI briefing</h2><span>${esc(b.date_label || '')}</span></div>
      <p class="ov">${esc(b.overview)}</p>
      ${crit.length ? `<h3>Top developments</h3><ul class="tops">${crit.map(c => `<li><button class="link" data-act="goto" data-id="${c.it.id}">${flagOf(c.it.country)} ${esc(c.it.headline)}</button><span>${esc(c.note)}</span></li>`).join('')}</ul>` : ''}
      ${(themes || chains || watch) ? `<details><summary>Themes and impact chains</summary>
        ${themes ? `<h3>Themes</h3><ul class="themes">${themes}</ul>` : ''}
        ${chains ? `<h3>Impact chains</h3><ul class="chains">${chains}</ul>` : ''}
        ${watch ? `<h3>Watchlist</h3><ul class="watch">${watch}</ul>` : ''}
      </details>` : ''}
    </section>`;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - S.lastLive > 5 * 60e3) loadLive(); });

  /* ---------- install and share ---------- */
  let deferredInstall = null;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); deferredInstall = e;
    $$('[data-install]').forEach(b => b.hidden = false);
  });
  window.addEventListener('appinstalled', () => { deferredInstall = null; $$('[data-install]').forEach(b => b.hidden = true); toast('Installed. Open it from your home screen.'); });
  $$('[data-install]').forEach(b => b.addEventListener('click', async () => {
    if (!deferredInstall) { toast('Open the browser menu and choose Install app or Add to Home screen.'); return; }
    deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null;
    $$('[data-install]').forEach(x => x.hidden = true);
  }));
  if (standalone) $('#installCard').hidden = true;

  /* ---------- start ---------- */
  (async function start() {
    $('#today').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const ok = await DB.init();
    if (ok) S.items = await DB.all(); else toast('Storage is blocked in this browser. Items will be lost when you close the page.');
    const qs = new URLSearchParams(location.search);
    const shared = ['title', 'text', 'url'].map(k => qs.get(k)).filter(Boolean).join('\n');
    if (shared) {
      $('#paste').value = shared; history.replaceState(null, '', location.pathname);
      toast('Shared text is ready. Tap Add to briefing.');
    }
    setTab('inbox'); renderFiles(); renderAll(); renderLiveBar();
    loadLive();
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => { }));
    }
  })();
})();
