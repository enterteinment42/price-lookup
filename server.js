/**
 * Price Lookup Service для проекта "Поиграем"
 *
 * Что делает:
 *   1. Принимает название игры от клиента
 *   2. Параллельно ищет в PS Store Турции и Индии
 *   3. Матчит результаты через parsers.js, конвертирует в RUB
 *   4. Возвращает минимальную цену
 */

import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import rateLimit from 'express-rate-limit';
import { parseSearchPage, matchGame, normalizeQuery } from './parsers.js';
import { createHash } from 'crypto';
import ws from 'ws';

const SUPABASE_OPTS = { realtime: { transport: ws } };

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  SUPABASE_OPTS
);

// Для чтения закрытых таблиц в admin-эндпоинте
const supabaseAdmin = process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, SUPABASE_OPTS)
  : supabase;

// =============================================================================
// КОНФИГ
// =============================================================================

const PORT = process.env.PORT || 3001;

// Тестовые запросы — на них проверяем что парсер работает
const TEST_QUERIES = [
  'Cyberpunk 2077',
  'Forza Horizon 5',
  'GTA V',
  'FC 25',
  'FC 26',
  'Spider-Man',
  'Ведьмак 3',   // кириллица
  'киберпанк',   // кириллица, нижний регистр, без номера
];

// Кэш настроек из Supabase (TTL 1 час)
let _settingsCache = null;
let _settingsCachedAt = 0;
const SETTINGS_TTL_MS = 60 * 60 * 1000;

async function getSettings() {
  if (_settingsCache && Date.now() - _settingsCachedAt < SETTINGS_TTL_MS) {
    return _settingsCache;
  }
  try {
    const [tiersResult, snapshotResult] = await Promise.all([
      supabase.from('settings').select('value').eq('key', 'markupTiers').single(),
      supabase.from('store_snapshot').select('data').eq('id', 'main').single(),
    ]);
    const s = snapshotResult.data?.data ?? {};
    const markupTiers = (Array.isArray(s.markupTiers) && s.markupTiers.length)
      ? s.markupTiers
      : (tiersResult.data?.value ?? [{from:0, to:null, markup:500}]);
    const rate     = parseFloat(s.rate)     || 2.8;
    const inrGift  = parseFloat(s.inrGift)  || 1030;
    const rounding = parseFloat(s.rounding) || 10;
    console.log(`[getSettings] rate=${rate} inrGift=${inrGift} rounding=${rounding}`);
    _settingsCache = { markupTiers, rate, inrGift, rounding };
    _settingsCachedAt = Date.now();
  } catch (e) {
    console.error('getSettings failed, using defaults:', e.message);
    if (!_settingsCache) {
      _settingsCache = { markupTiers: [{from:0, to:null, markup:500}], rate:2.8, inrGift:1030, rounding:10 };
      // Дефолт rate=2.8 при реальном ~1.8 → завышение цен на ~50%. Нужно знать сразу.
      sendTgAlert(`⚠️ price-lookup: getSettings упал на дефолты (rate=2.8, markup=500). Цены могут быть завышены!\n${e.message}`);
    }
    _settingsCachedAt = Date.now(); // не давать каждому запросу снова лезть в Supabase при падении
  }
  return _settingsCache;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 часов (цены могут меняться при акциях)

async function getCached(queryNormalized, region, { stale = false } = {}) {
  try {
    let q = supabase
      .from('price_lookup_cache')
      .select('result')
      .eq('query_normalized', queryNormalized)
      .eq('region', region);
    if (!stale) {
      const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString();
      q = q.gte('fetched_at', cutoff);
    }
    const { data } = await q.single();
    return data?.result ?? null;
  } catch {
    return null;
  }
}

async function setCached(queryNormalized, region, result) {
  try {
    await supabase
      .from('price_lookup_cache')
      .upsert(
        { query_normalized: queryNormalized, region, result, fetched_at: new Date().toISOString() },
        { onConflict: 'query_normalized,region' }
      );
  } catch (e) {
    console.error('setCached failed:', e.message);
  }
}

async function logSearch({ gameQuery, queryNormalized, status, foundGame, priceTr, priceIn, winnerRegion, rateUsed, markupUsed, priceRub, ipHash, source }) {
  try {
    await supabase.from('price_lookup_log').insert({
      game_query:       gameQuery?.slice(0, 200),
      query_normalized: queryNormalized,
      status,
      found_game:       foundGame ?? null,
      price_tr:         priceTr ?? null,
      price_in:         priceIn ?? null,
      winner_region:    winnerRegion ?? null,
      rate_used:        rateUsed ?? null,
      markup_used:      markupUsed ?? null,
      price_rub:        priceRub ?? null,
      ip_hash:          ipHash ?? null,
      source:           source ?? 'direct',
      created_at:       new Date().toISOString(),
    });
  } catch (e) {
    console.error('logSearch failed:', e.message);
  }
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// =============================================================================
// УТИЛИТЫ
// =============================================================================

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

// Порог TR-приоритета: Индия побеждает Турцию, только если её рублёвая цена
// не выше trBest × этого множителя, т.е. дешевле минимум на 12% ОТ турецкой цены.
// Турция обычно самый дешёвый регион и стабильнее по механике гифт-карт, поэтому
// переключаемся на Индию лишь при ощутимом выигрыше. Один источник для winner и
// для дедупликации изданий — чтобы выбранная цена и список изданий не разъехались.
const TR_PRIORITY_FACTOR = 1 - 0.12;

async function convertToRub(priceLocal, currency) {
  const { markupTiers, rate, inrGift, rounding } = await getSettings();
  let base;
  if (currency === 'TRY') {
    base = priceLocal * rate;
  } else if (currency === 'INR') {
    base = Math.ceil(priceLocal / 1000) * inrGift;
  } else {
    return null;
  }
  // Та же логика что в pricing.js магазина: используем nextFrom, а не t.to
  let markup = markupTiers[markupTiers.length - 1].markup;
  for (let i = 0; i < markupTiers.length; i++) {
    const nextFrom = i + 1 < markupTiers.length ? markupTiers[i + 1].from : Infinity;
    if (base >= markupTiers[i].from && base < nextFrom) { markup = markupTiers[i].markup; break; }
  }
  const priceRub = Math.ceil((base + markup) / rounding) * rounding;
  return { priceRub, markup, rateUsed: currency === 'TRY' ? rate : inrGift };
}

// =============================================================================
// IGDB — обложки игр
// =============================================================================

const IGDB_COVER_ENDPOINT    = process.env.IGDB_COVER_ENDPOINT    || 'https://api.poigraem.shop/igdb/cover';
const IGDB_SUGGEST_ENDPOINT  = process.env.IGDB_SUGGEST_ENDPOINT  || 'https://api.poigraem.shop/igdb/suggest';

// Стрипает суффиксы изданий: "Ghost of Yotei: Deluxe Edition" → "Ghost of Yotei"
// Не трогает подзаголовки типа "The Witcher 3: Wild Hunt" — они не попадают под паттерн
const EDITION_RE = /\s*:?\s*(deluxe|standard|digital|gold|platinum|ultimate|complete|premium|goty|game\s+of\s+the\s+year|definitive|legendary|anniversary|collector'?s?|enhanced|director'?s?)\s+(edition|cut|version)\s*$/i;
const EDITION_WORD_RE = /\s*:?\s*(deluxe|gold|platinum|ultimate|premium|goty|definitive|legendary|enhanced)\s*$/i;

function stripEditionSuffix(name) {
  let s = String(name);
  let prev;
  // Чистим в цикле: сначала снимается "(PS5)", после чего "Ultimate Edition"
  // оказывается в конце строки и снимается на следующем проходе.
  do {
    prev = s;
    s = s
      // Платформа в скобках в конце: "(PS5)", "(PS4 & PS5)", "(PlayStation 5)"
      .replace(/\s*\((?:PS[45]|PlayStation\s*\d?|Xbox(?:\s+One|\s+Series\s*[XS])?)(?:\s*&\s*[^)]+)?\)\s*$/i, '')
      // Платформенные суффиксы без скобок: "PS4 & PS5", "PS5", "Xbox One" в конце
      .replace(/\s+(?:PS[45]|PlayStation\s*\d?|Xbox(?:\s+One|\s+Series\s*[XS])?)(?:\s*&\s*(?:PS[45]|Xbox(?:\s+One|\s+Series\s*[XS])?))*\s*$/i, '')
      .replace(EDITION_RE, '')
      .replace(EDITION_WORD_RE, '')
      .replace(/\s*:\s*$/, '')
      .trim();
  } while (s && s !== prev);
  return s || name;
}

// Чистит название из PS Store перед отправкой в IGDB:
//   - нормализует диакритику: "Yōtei" → "Yotei", "Pokémon" → "Pokemon"
//   - убирает товарные знаки ™ ® © и схлопывает пробелы
// PS Store любит украшать названия (™, макроны) — IGDB по такому либо не находит игру,
// либо находит спин-офф. Чистое название матчится надёжно.
function cleanGameName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[™®©'']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchIgdbCoverRaw(gameName) {
  try {
    const r = await fetch(`${IGDB_COVER_ENDPOINT}?name=${encodeURIComponent(gameName)}`);
    if (!r.ok) return null;
    const d = await r.json();
    return d.cover || null;
  } catch {
    return null;
  }
}

async function fetchIgdbCover(psStoreName) {
  const clean = cleanGameName(psStoreName);
  const base = stripEditionSuffix(clean);
  // Базовое название матчится надёжнее: бэкенд требует, чтобы все слова запроса были
  // в названии игры, а у базовой игры нет слов "deluxe"/"edition".
  let cover = await fetchIgdbCoverRaw(base);
  if (cover) return cover;
  // Фоллбэк — полное чистое название (если "edition"-слово оказалось частью реального тайтла)
  if (clean !== base) cover = await fetchIgdbCoverRaw(clean);
  return cover;
}

// =============================================================================
// ПАРСЕР PS STORE
// =============================================================================

async function searchInRegion(query, region) {
  const localeMap = { tr: 'en-tr', in: 'en-in' };
  const locale = localeMap[region];
  const url = `https://store.playstation.com/${locale}/search/${encodeURIComponent(query)}`;

  console.log(`[search/${region}] GET ${url}`);
  const html = await fetchHtml(url);
  return parseSearchPage(html, region);
}

// =============================================================================
// ПЕРЕВОД КИРИЛЛИЧЕСКИХ ЗАПРОСОВ
// =============================================================================

// Порядок важен: более длинные фразы — первыми, чтобы "ведьмак 3" не матчилось на "ведьмак"
const CYRILLIC_TRANSLATE = [
  // God of War
  ['год оф вар рагнарек', 'god of war ragnarok'],
  ['год оф вар',          'god of war'],
  ['бог войны',           'god of war'],
  // FIFA / EA Sports FC — с годом сначала, потом общее
  ['фифа 26',             'ea sports fc 26'],
  ['фифа26',              'ea sports fc 26'],
  ['фк 26',               'ea sports fc 26'],
  ['фк26',                'ea sports fc 26'],
  ['фифа 25',             'ea sports fc 25'],
  ['фифа25',              'ea sports fc 25'],
  ['фк 25',               'ea sports fc 25'],
  ['фк25',                'ea sports fc 25'],
  ['фифа',                'ea sports fc'],
  // Ведьмак
  ['ведьмак 3',           'the witcher 3'],
  ['ведьмак 2',           'the witcher 2'],
  ['ведьмак',             'the witcher'],
  // Киберпанк
  ['киберпанк 2077',      'cyberpunk 2077'],
  ['киберпанк',           'cyberpunk 2077'],
  // Assassin's Creed — все варианты написания
  ['ассассин',            "assassin's creed"],
  ['ассасин',             "assassin's creed"],
  ['асасин',              "assassin's creed"],
  // Spider-Man
  ['человек паук',        'marvel spider-man'],
  ['спайдермен',          'marvel spider-man'],
  ['спайдер мен',         'marvel spider-man'],
  // Call of Duty
  ['кол оф дьюти',        'call of duty'],
  ['кол оф дути',         'call of duty'],
  // Battlefield
  ['батлфилд',            'battlefield'],
  ['батла',               'battlefield'],
  // Hogwarts Legacy — в IGDB нет русского альт-имени, перевод возможен только словарём
  ['хогвартс легаси',     'hogwarts legacy'],
  ['хогвартс наследие',   'hogwarts legacy'],
  ['хогвардс',            'hogwarts legacy'],
  ['хогвартс',            'hogwarts legacy'],
  // Другие
  ['одни из нас',         'the last of us'],
  ['мортал комбат',       'mortal kombat'],
  ['анчартед',            'uncharted'],
  ['хорайзон',            'horizon'],
  ['хорайзн',             'horizon'],
  ['горизонт',            'horizon'],
  ['фар край',            'far cry'],
  ['арк райдерс',         'arc raiders'],
  ['дьябло',              'diablo'],
  ['диабло',              'diablo'],
  ['мафия',               'mafia'],
  ['нхл',                 'nhl'],
  ['нба',                 'nba 2k'],
  ['нфс',                 'need for speed'],
  ['нид фор спид',        'need for speed'],
  ['форза',               'forza horizon'],
  ['рдр',                 'red dead redemption'],
  ['гта',                 'grand theft auto'],
];

function translateQuery(s) {
  const lower = s.toLowerCase().trim();
  for (const [ru, en] of CYRILLIC_TRANSLATE) {
    if (lower.includes(ru)) return lower.replace(ru, en).trim();
  }
  return null;
}

// Латинские синонимы/аббревиатуры. EA переименовала FIFA → EA Sports FC:
// PS Store находит игру по "FC 26", но матчер режет короткий запрос
// (2 слова против 8 в "EA SPORTS FC 26 Standard Edition") по порогу покрытия.
// Разворачиваем в полное имя — тогда матч идёт как по "EA Sports FC 26".
// Обновлять список по годам (как и кириллические фк/фифа выше).
const LATIN_ALIASES = [
  // Длинные формы первыми — чтобы "ea fc 26" не переписывался частично по "fc 26"
  ['ea fc 26',  'ea sports fc 26'],
  ['ea fc26',   'ea sports fc 26'],
  ['fc 26',     'ea sports fc 26'],
  ['fc26',      'ea sports fc 26'],
  ['ea fc 25',  'ea sports fc 25'],
  ['ea fc25',   'ea sports fc 25'],
  ['fc 25',     'ea sports fc 25'],
  ['fc25',      'ea sports fc 25'],
];
function aliasLatinQuery(s) {
  const lower = s.toLowerCase().trim();
  for (const [abbr, full] of LATIN_ALIASES) {
    if (lower.includes(full)) continue; // уже содержит полную форму — не трогаем
    if (lower === abbr || lower.startsWith(abbr + ' ')) {
      return lower.replace(abbr, full).trim();
    }
  }
  return null;
}

// =============================================================================
// ОСНОВНАЯ ЛОГИКА
// =============================================================================

async function lookupPrice(gameName, opts = {}) {
  console.log(`\n=== Lookup: "${gameName}" ===`);

  const hasCyrillic = /[а-яёА-ЯЁ]/.test(gameName);
  let translated = hasCyrillic ? translateQuery(gameName) : aliasLatinQuery(gameName);
  if (hasCyrillic && !translated) {
    try {
      const r = await fetch(`${IGDB_SUGGEST_ENDPOINT}?q=${encodeURIComponent(gameName)}`);
      const names = r.ok ? await r.json() : [];
      if (names.length > 0) { translated = names[0]; console.log(`[igdb translate] "${gameName}" → "${translated}"`); }
    } catch { /* fall through to trustTop */ }
  }

  // Если есть перевод — ищем на английском, биграммы работают нормально.
  // Если нет — ищем оригиналом и доверяем позиции PS Store (trustTop).
  const searchQuery = translated ?? gameName;
  const matchQuery  = translated ?? gameName;
  const matchOpts   = (hasCyrillic && !translated) ? { ...opts, trustTop: true } : opts;
  const cacheKey    = normalizeQuery(searchQuery);

  // Проверяем кэш для обоих регионов
  const [cachedTR, cachedIN] = await Promise.all([
    getCached(cacheKey, 'tr'),
    getCached(cacheKey, 'in'),
  ]);

  const fetchRegion = async (region, cached) => {
    if (cached) { console.log(`[cache hit] ${region} "${cacheKey}"`); return cached; }
    let result;
    try {
      result = await searchInRegion(searchQuery, region);
    } catch (e) {
      console.error(`${region.toUpperCase()} search failed:`, e.message);
      // Sony заблокировала/недоступна — пробуем любой кэш без TTL
      const staleResult = await getCached(cacheKey, region, { stale: true });
      if (staleResult) console.log(`[stale cache] ${region} "${cacheKey}"`);
      return staleResult ?? [];
    }
    if (result.length > 0) setCached(cacheKey, region, result); // fire-and-forget; не кэшируем пустые (капча/временный сбой Sony)
    return result;
  };

  let [trCandidates, inCandidates] = await Promise.all([
    fetchRegion('tr', cachedTR),
    fetchRegion('in', cachedIN),
  ]);

  // A: TR — самый дешёвый регион. Если он вернул 0 кандидатов, а Индия что-то нашла,
  // это почти всегда транзиентный сбой/антибот Sony (турецкий каталог PS Store —
  // надмножество; игр «есть в IN, но нет в TR» единицы). Пустая страница отличается
  // от «TR ответил 24 кандидата, но нужной игры среди них нет» (реальное отсутствие в TR):
  // там trCandidates.length > 0 и ретрай не запускается. Один повтор через паузу ловит
  // случайные пустые ответы, не завися от кэша (важно для редких/первых запросов).
  if (trCandidates.length === 0 && inCandidates.length > 0) {
    await sleep(600 + Math.random() * 600);
    try {
      const retry = await searchInRegion(searchQuery, 'tr');
      console.log(`[tr retry] "${searchQuery}" → ${retry.length} candidates`);
      if (retry.length > 0) { trCandidates = retry; setCached(cacheKey, 'tr', retry); }
    } catch (e) {
      console.error('TR retry failed:', e.message);
    }
  }

  // Если TR пуст даже после ретрая, а Индия нашла игру — цену показываем индийскую,
  // но пометим её неопределённой (C) и просигналим себе (D): турецкую (обычно самую
  // дешёвую) цену проверить не удалось, показанная может быть завышена.
  const trUnavailable = trCandidates.length === 0 && inCandidates.length > 0;

  console.log(`Candidates: TR=${trCandidates.length}, IN=${inCandidates.length} (searched: "${searchQuery}")${trUnavailable ? ' [TR unavailable]' : ''}`);

  const trMatch = matchGame(matchQuery, trCandidates, matchOpts);
  const inMatch = matchGame(matchQuery, inCandidates, matchOpts);

  // Собираем ВСЕ авто-кандидаты (best + alternatives) из обоих регионов с конвертацией в рубли
  const allOptions = [];
  const addRegionOptions = async (match, currency) => {
    if (match.status !== 'found') return;
    const cands = [match.best, ...(match.alternatives || [])].filter(c => c?.effectivePriceLocal != null);
    for (const c of cands) {
      const conv = await convertToRub(c.effectivePriceLocal, currency);
      if (conv) allOptions.push({ candidate: c, conv, currency });
    }
  };
  await Promise.all([
    addRegionOptions(trMatch, 'TRY'),
    addRegionOptions(inMatch, 'INR'),
  ]);

  if (allOptions.length > 0) {
    const trOptions = allOptions.filter(o => o.currency === 'TRY').sort((a, b) => a.conv.priceRub - b.conv.priceRub);
    const inOptions = allOptions.filter(o => o.currency === 'INR').sort((a, b) => a.conv.priceRub - b.conv.priceRub);
    const trBest = trOptions[0] ?? null;
    const inBest = inOptions[0] ?? null;

    // TR-приоритет: Индия побеждает, только если дешевле Турции на ≥12%
    // (порог считается ОТ турецкой цены, т.е. inRub <= trRub * (1 - 0.12)).
    // Запас над классом «новых игр» вида 3449 TL / 4999 ₹ (разрыв ~13.7%): при 12%
    // такие тайтлы уверенно уходят в Индию (Marvel's Wolverine: TR 7360 ₽ vs IN 6350 ₽),
    // не прыгая между регионами при обычном движении курса. TR_PRIORITY_FACTOR = 1 - 0.12.
    let chosen;
    if (trBest && inBest) {
      chosen = inBest.conv.priceRub <= trBest.conv.priceRub * TR_PRIORITY_FACTOR ? inBest : trBest;
    } else {
      chosen = trBest ?? inBest;
    }

    const { candidate, conv, currency } = chosen;
    console.log(`  [winner] TR=${trBest?.conv.priceRub ?? '—'} (${trBest?.candidate.name}) IN=${inBest?.conv.priceRub ?? '—'} (${inBest?.candidate.name}) → ${conv.priceRub} (${candidate.name})`);

    // C+D: цена индийская, потому что TR не ответил (после ретрая) — не смогли сверить
    // с турецкой (обычно самой дешёвой). Помечаем ответ и один раз шлём алерт себе.
    const priceUncertain = trUnavailable && currency === 'INR';
    if (priceUncertain) {
      sendTgAlert(`⚠️ price-lookup: TR пуст после ретрая для «${escHtml(gameName)}» — показана индийская цена ${conv.priceRub} ₽ (${escHtml(candidate.name)}). Возможно завышена; проверьте вручную.`);
    }

    // Все издания (включая выбранное) — для показа списком в UI.
    // Дедупликация по нормализованному имени с тем же TR-приоритетом что и у winner:
    // IN-версия издания вытесняет TR только если дешевле на ≥12% (TR_PRIORITY_FACTOR).
    const editionsByName = new Map();
    for (const o of allOptions) {
      const n = normalizeQuery(o.candidate.name);
      const existing = editionsByName.get(n);
      if (!existing) {
        editionsByName.set(n, o);
      } else if (existing.currency !== o.currency) {
        const tr = o.currency === 'TRY' ? o : existing;
        const inOpt = o.currency === 'INR' ? o : existing;
        editionsByName.set(n, inOpt.conv.priceRub <= tr.conv.priceRub * TR_PRIORITY_FACTOR ? inOpt : tr);
      } else if (o.conv.priceRub < existing.conv.priceRub) {
        editionsByName.set(n, o);
      }
    }
    const editions = [...editionsByName.values()]
      .sort((a, b) => a.conv.priceRub - b.conv.priceRub)
      .slice(0, 3)
      .map(o => ({
        name: o.candidate.name,
        priceRUB: o.conv.priceRub,
        coverUrl: o.candidate.coverUrl || null,
        isOnSale: o.candidate.isOnSale || false,
        discountText: o.candidate.discountText || null,
      }));

    return {
      status: 'found',
      priceRUB: conv.priceRub,
      neutralLabel: candidate.name,
      isOnSale: candidate.isOnSale || false,
      discountText: candidate.discountText || null,
      priceUncertain,
      editions,
      _details: {
        queryNormalized: cacheKey,
        psCover: candidate.coverUrl || null,
        foundGame: candidate.name,
        priceTr: trBest?.candidate.effectivePriceLocal ?? null,
        priceIn: inBest?.candidate.effectivePriceLocal ?? null,
        winnerRegion: currency === 'TRY' ? 'TR' : 'IN',
        rateUsed: conv.rateUsed,
        markupUsed: conv.markup,
      },
    };
  }

  // Серая зона — есть кандидаты, но уверенности нет
  if (trMatch.status === 'ambiguous' || inMatch.status === 'ambiguous') {
    const merged = [
      ...(trMatch.status === 'ambiguous' ? trMatch.candidates : []),
      ...(inMatch.status === 'ambiguous' ? inMatch.candidates : []),
    ];
    const seen = new Set();
    const unique = merged.filter((c) => {
      if (seen.has(c.name)) return false;
      seen.add(c.name);
      return true;
    });
    const candidatesWithCovers = await Promise.all(
      unique.slice(0, 5).map(async (c) => {
        const coverUrl = c.coverUrl || await Promise.race([
          fetchIgdbCover(c.name),
          new Promise(r => setTimeout(() => r(null), 2000)),
        ]);
        return { name: c.name, coverUrl };
      })
    );
    return {
      status: 'ambiguous',
      candidates: candidatesWithCovers,
      _details: { queryNormalized: cacheKey },
    };
  }

  return { status: 'not_found', suggestion: 'manual_request', _details: { queryNormalized: cacheKey } };
}

// =============================================================================
// HTTP API
// =============================================================================

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTgAlert(text) {
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('[tg alert] failed:', e.message);
  }
}

async function sendChatbotMessage(chatId, text) {
  const token = process.env.CHATBOT_TG_TOKEN;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('[chatbot msg] failed:', e.message);
  }
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

// CORS ДО лимитеров (PL-15): OPTIONS-preflight магазина (poigraem.shop → api.poigraem.shop)
// иначе тратил токен лимита наравне с реальным запросом и при исчерпанном лимите падал
// без CORS-заголовков — браузер клиента видел сетевую ошибку вместо честного 429.
const ALLOWED_ORIGINS = ['https://poigraem.shop', 'https://www.poigraem.shop', 'https://api.poigraem.shop', 'https://igropolka.com', 'https://www.igropolka.com', 'https://api.igropolka.com', 'null'];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_PER_HOUR) || 10,
  message: { error: 'rate_limited', message: 'Слишком много запросов, попробуйте через час', retry_after: 3600 },
});
// Автоподсказки бьют в IGDB (не в Sony) и дёргаются на каждую букву —
// им строгий анти-бан-лимит не нужен, отдельный щедрый.
const suggestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.SUGGEST_LIMIT_PER_HOUR) || 120,
  message: { error: 'rate_limited', message: 'Слишком много запросов, попробуйте через час', retry_after: 3600 },
});
// Обложки для админки магазина: дёргают Sony, поэтому щит от перегруза,
// но щедрее ценового (10/час) — заливаем каталог пачками.
const coversLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.COVERS_LIMIT_PER_HOUR) || 150,
  message: { error: 'rate_limited', message: 'Слишком много запросов обложек, попробуйте позже', retry_after: 3600 },
});
// Заявки из корзины магазина: Sony не дёргают, но спамить формой не даём.
// Лимит отдельный от поискового — иначе клиент, поискавший 10 игр, потеряет заявку.
const orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.ORDER_LIMIT_PER_HOUR) || 5,
  message: { error: 'rate_limited', message: 'Слишком много заявок, попробуйте через час', retry_after: 3600 },
});
// Заявка "рассчитаем вручную" + подписка на скидку (PL-3): Sony не дёргают, отдельный
// счётчик от поиска — иначе клиент, поискавший 10 игр, теряет возможность оставить заявку/подписаться.
const leadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.LEAD_LIMIT_PER_HOUR) || 10,
  message: { error: 'rate_limited', message: 'Слишком много запросов, попробуйте через час', retry_after: 3600 },
});
app.use('/api/price-lookup', limiter);
app.use('/api/price-request', leadLimiter);
app.use('/api/suggest', suggestLimiter);
app.use('/api/price-watch', leadLimiter);
app.use('/api/admin/covers', coversLimiter);
app.use('/api/order-request', orderLimiter);

app.use(express.static('public'));

app.get('/api/suggest', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json([]);
  try {
    const r = await fetch(`${IGDB_SUGGEST_ENDPOINT}?q=${encodeURIComponent(q)}`);
    res.json(r.ok ? await r.json() : []);
  } catch {
    res.json([]);
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'price-lookup', version: '0.1.0' });
});

// =============================================================================
// ADMIN: обложки PS Store для админки магазина (вынос обложек по изданиям)
// Защита: X-Admin-Token (выставлен равным токену магазина — «вариант А»).
// =============================================================================
function _checkAdmin(req, res) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Снимает платформенный токен (PS4/PS5/PlayStation 4|5) из названия перед поиском.
// Платформа у Sony — метаданные, в имени игры её обычно нет → приписка мешает матчу.
// Издания (Ultimate/Deluxe/™) НЕ трогаем: обложка нужна точная. Обложка PS4=PS5, версию не различаем.
function stripPlatformTag(s) {
  return String(s)
    .replace(/[\[(]\s*(?:sony\s*)?(?:playstation|ps)[®™\s]*[45]?(?:\s*[&/]\s*(?:ps\s*)?[45])?\s*[\])]/gi, ' ') // (PS5), [PS4 & PS5], (PlayStation®5)
    .replace(/\b(?:sony\s*)?playstation[®™\s]*[45]\b/gi, ' ')  // PlayStation 5
    .replace(/\bps\s?[45]\b/gi, ' ')                            // PS4, PS 5
    .replace(/\s{2,}/g, ' ').trim();
}

// Поиск обложек по названию. Один регион (обложке хватит одного, в отличие от цен).
// Возвращает кандидатов с обложками PS Store по изданиям — для пикера и bulk.
app.get('/api/admin/covers', async (req, res) => {
  if (!_checkAdmin(req, res)) return;
  const name = (req.query.name || '').trim();
  const region = req.query.region === 'in' ? 'in' : 'tr';
  if (!name) return res.json({ candidates: [] });
  try {
    // Снимаем платформу ("The Division PS4" → "The Division"), издания оставляем.
    const cleanName = stripPlatformTag(name) || name;
    // Та же подготовка запроса, что в lookupPrice: кириллица → англ., латинские алиасы франшиз.
    const hasCyrillic = /[а-яёА-ЯЁ]/.test(cleanName);
    const translated = hasCyrillic ? translateQuery(cleanName) : aliasLatinQuery(cleanName);
    const searchQuery = translated ?? name;
    const cacheKey = normalizeQuery(searchQuery);

    let candidates = await getCached(cacheKey, region);
    if (!candidates) {
      candidates = await searchInRegion(searchQuery, region);
      if (candidates.length > 0) setCached(cacheKey, region, candidates); // fire-and-forget
    }

    // Только с обложкой, дедуп по URL, топ-8 (порядок — релевантность от Sony).
    const seen = new Set();
    const out = [];
    for (const c of candidates) {
      if (!c.coverUrl || seen.has(c.coverUrl)) continue;
      seen.add(c.coverUrl);
      out.push({ name: c.name, coverUrl: c.coverUrl });
      if (out.length >= 8) break;
    }
    res.json({ candidates: out });
  } catch (e) {
    console.error('[admin/covers]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Server-side скачивание картинки (IGDB или PS Store CDN) → base64.
// Обходит canvas-taint/CORS у Sony и DPI-блок. Хост в белом списке (анти-SSRF).
const COVER_HOST_WHITELIST = ['image.api.playstation.com', 'images.igdb.com'];
app.get('/api/admin/cover-data', async (req, res) => {
  if (!_checkAdmin(req, res)) return;
  const raw = (req.query.url || '').trim();
  let u;
  try { u = new URL(raw); } catch { return res.status(400).json({ error: 'bad_url' }); }
  if (u.protocol !== 'https:' || !COVER_HOST_WHITELIST.includes(u.hostname)) {
    return res.status(403).json({ error: 'host_not_allowed' });
  }
  try {
    const r = await fetch(u.href, { headers: { 'User-Agent': BROWSER_UA } });
    if (!r.ok) return res.status(502).json({ error: `upstream_${r.status}` });
    const ct = r.headers.get('content-type') || 'image/jpeg';
    if (!ct.startsWith('image/')) return res.status(415).json({ error: 'not_an_image' });
    const buf = Buffer.from(await r.arrayBuffer());
    res.json({ dataUrl: `data:${ct};base64,${buf.toString('base64')}` });
  } catch (e) {
    console.error('[admin/cover-data]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// Публичный конфиг для фронтенда — только несекретные данные
app.get('/api/config', (req, res) => {
  res.json({
    managerType:   process.env.MANAGER_PRIMARY_TYPE   || 'telegram',
    managerValue:  process.env.MANAGER_PRIMARY_VALUE  || '',
    fallbackType:  process.env.MANAGER_FALLBACK_TYPE  || '',
    fallbackValue: process.env.MANAGER_FALLBACK_VALUE || '',
    botName:       process.env.CHATBOT_BOT_NAME       || '',
  });
});

app.post('/api/price-lookup', async (req, res) => {
  const { gameName, platform, source } = req.body;
  if (!gameName || typeof gameName !== 'string') {
    return res.status(400).json({ error: 'gameName is required' });
  }

  const rawIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  const ipHash = createHash('sha256').update((process.env.IP_HASH_SALT || '') + rawIp).digest('hex');

  try {
    const result = await lookupPrice(gameName, { platform });
    const d = result._details || {};
    logSearch({
      gameQuery:       gameName,
      queryNormalized: d.queryNormalized ?? normalizeQuery(gameName),
      status:          result.status,
      foundGame:       d.foundGame ?? null,
      priceTr:         d.priceTr ?? null,
      priceIn:         d.priceIn ?? null,
      winnerRegion:    d.winnerRegion ?? null,
      rateUsed:        d.rateUsed ?? null,
      markupUsed:      d.markupUsed ?? null,
      priceRub:        result.priceRUB ?? null,
      ipHash,
      source:          source || 'direct',
    });
    const { _details: _d, ...clientResult } = result;

    // Обложка: сначала PS Store (уже в данных, 0 запросов), IGDB — фоллбэк
    let coverUrl = null;
    if (result.status === 'found') {
      coverUrl = d.psCover || await Promise.race([
        fetchIgdbCover(result.neutralLabel),
        new Promise(r => setTimeout(() => r(null), 2500)),
      ]);
    }
    res.json({ ...clientResult, coverUrl });
  } catch (e) {
    console.error('lookupPrice failed:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/price-request', async (req, res) => {
  const { gameName, contact, contactType, source } = req.body;
  if (!gameName || typeof gameName !== 'string') {
    return res.status(400).json({ error: 'gameName is required' });
  }

  const rawIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  const ipHash = createHash('sha256').update((process.env.IP_HASH_SALT || '') + rawIp).digest('hex');

  try {
    const { error } = await supabase.from('price_lookup_requests').insert({
      game_query:     gameName.trim().slice(0, 200),
      client_contact: contact?.trim().slice(0, 200) || null,
      contact_type:   contactType || null,
      status:         'new',
      ip_hash:        ipHash,
      source:         source || 'direct',
      created_at:     new Date().toISOString(),
    });
    if (error) throw error;
    console.log(`[price-request] "${gameName}" contact=${contactType}:${contact}`);
    const ctIcon = { telegram: '✈️', vk: '💬', phone: '📞' }[contactType] || '📩';
    sendTgAlert(`🎮 <b>Новая заявка — Поиграем</b>\n\nИгра: <b>${escHtml(gameName.trim())}</b>\nКонтакт: ${ctIcon} ${escHtml(contact || '—')}`);
    res.json({ status: 'ok' });
  } catch (e) {
    console.error('price-request insert failed:', e.message);
    res.status(500).json({ error: 'Не удалось сохранить заявку' });
  }
});

// Заявка из корзины магазина (COM-4): список позиций + контакты клиента.
// В БД текст заказа усечён до 200 (как game_query у price-request), полный — в TG-уведомлении.
app.post('/api/order-request', async (req, res) => {
  const { orderText, contact } = req.body;
  if (!contact || typeof contact !== 'string' || !contact.trim()) {
    return res.status(400).json({ error: 'Укажите контакт для связи' });
  }
  const order = (typeof orderText === 'string' && orderText.trim())
    ? orderText.trim().slice(0, 1500)
    : 'Заказ из корзины (без списка позиций)';

  const rawIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  const ipHash = createHash('sha256').update((process.env.IP_HASH_SALT || '') + rawIp).digest('hex');

  try {
    const { error } = await supabase.from('price_lookup_requests').insert({
      game_query:     order.slice(0, 200),
      client_contact: contact.trim().slice(0, 200),
      contact_type:   'order',
      status:         'new',
      ip_hash:        ipHash,
      source:         'shop_cart',
      created_at:     new Date().toISOString(),
    });
    if (error) throw error;
    console.log(`[order-request] contact=${contact.trim().slice(0, 100)}`);
    sendTgAlert(`🛒 <b>Новый заказ — Поиграем</b>\n\n${escHtml(order)}\n\n📞 Контакты клиента:\n${escHtml(contact.trim())}`);
    res.json({ status: 'ok' });
  } catch (e) {
    console.error('order-request insert failed:', e.message);
    res.status(500).json({ error: 'Не удалось отправить заявку' });
  }
});

app.get('/api/admin/logs', async (req, res) => {
  const adminToken = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN || adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const [logsRes, requestsRes, demandRes] = await Promise.all([
      supabaseAdmin.from('price_lookup_log').select('*').order('created_at', { ascending: false }).limit(100),
      supabaseAdmin.from('price_lookup_requests').select('*').order('created_at', { ascending: false }).limit(50),
      supabaseAdmin.from('price_lookup_log').select('query_normalized, game_query, created_at').eq('status', 'not_found').limit(2000),
    ]);

    // Агрегируем незакрытый спрос: группируем по query_normalized, считаем кол-во
    const demandMap = {};
    for (const row of (demandRes.data ?? [])) {
      const key = row.query_normalized || row.game_query || '?';
      if (!demandMap[key]) demandMap[key] = { query: row.game_query || key, count: 0, lastAt: row.created_at };
      demandMap[key].count++;
      if (row.created_at > demandMap[key].lastAt) demandMap[key].lastAt = row.created_at;
    }
    const demand = Object.values(demandMap).sort((a, b) => b.count - a.count).slice(0, 20);

    res.json({ logs: logsRes.data ?? [], requests: requestsRes.data ?? [], demand });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/price-watch/init', async (req, res) => {
  const { gameName, priceRub, gameLabel } = req.body;
  if (!gameName || typeof gameName !== 'string') return res.status(400).json({ error: 'gameName and priceRub required' });
  // PL-19: без границ клиент мог прислать любую priceRub (например завышенную) и получить
  // гарантированное "подешевело" на первой же проверке — цены магазина в этом диапазоне.
  const priceNum = Number(priceRub);
  if (!Number.isFinite(priceNum) || priceNum <= 0 || priceNum > 100000) {
    return res.status(400).json({ error: 'gameName and priceRub required' });
  }
  const token = createHash('sha256')
    .update(String(Date.now()) + gameName + String(Math.random()))
    .digest('hex')
    .slice(0, 16);
  try {
    const { error } = await supabase.from('price_watchlist').insert({
      token,
      game_query:             gameName.trim().slice(0, 200),
      query_normalized:       normalizeQuery(gameName),
      game_name:              (gameLabel || gameName).trim().slice(0, 200),
      price_at_subscribe_rub: Math.round(priceNum),
      active:                 false,
      created_at:             new Date().toISOString(),
    });
    if (error) throw error;
    res.json({ token });
  } catch (e) {
    console.error('price-watch init failed:', e.message);
    res.status(500).json({ error: 'Не удалось создать подписку' });
  }
});

// Отладочный эндпоинт — посмотреть сырые кандидаты из региона. На проде отключить.
app.get('/test/search/:region/:query', async (req, res) => {
  const adminToken = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN || adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const candidates = await searchInRegion(req.params.query, req.params.region);
    res.json({ count: candidates.length, candidates });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// WATCHLIST — периодическая проверка цен и уведомления
// =============================================================================

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function checkWatchlist() {
  console.log('[watchlist] checking prices...');
  const { data: watches, error } = await supabaseAdmin
    .from('price_watchlist')
    .select('*')
    .eq('active', true)
    .not('tg_chat_id', 'is', null);
  if (!error && watches?.length) {
    const DROP = parseFloat(process.env.WATCH_PRICE_DROP_THRESHOLD) || 0.15;

    for (const w of watches) {
      try {
        const result = await lookupPrice(w.game_query);
        if (result.status !== 'found') continue;

        const newPrice = result.priceRUB;
        await supabaseAdmin.from('price_watchlist').update({
          last_price_rub:  newPrice,
          last_checked_at: new Date().toISOString(),
        }).eq('id', w.id);

        if (newPrice <= w.price_at_subscribe_rub * (1 - DROP)) {
          const drop = Math.round((1 - newPrice / w.price_at_subscribe_rub) * 100);
          const shopUrl = `https://poigraem.shop/?order=${encodeURIComponent(w.game_name)}&price=${newPrice}`;
          await sendChatbotMessage(
            w.tg_chat_id,
            `🎉 <b>${escHtml(w.game_name)}</b> подешевела!\n\n` +
            `Было: ${w.price_at_subscribe_rub.toLocaleString('ru-RU')} ₽\n` +
            `Стало: <b>от ${newPrice.toLocaleString('ru-RU')} ₽</b> (−${drop}%)\n\n` +
            `<a href="${shopUrl}">🛒 Добавить в корзину</a>`
          );
          await supabaseAdmin.from('price_watchlist').update({
            active:      false,
            notified_at: new Date().toISOString(),
          }).eq('id', w.id);
          console.log(`[watchlist] notified chat_id=${w.tg_chat_id} for "${w.game_name}" −${drop}%`);
        }
      } catch (e) {
        console.error(`[watchlist] error for "${w.game_query}":`, e.message);
      }
      // PL-6: не бомбить Sony подряд без пауз — та же задержка, что и для обычного поиска.
      await sleep(200 + Math.random() * 600);
    }
  }
  await cleanupStaleWatches();
}

// PL-19: подписки, брошенные клиентом (Telegram-бот так и не открыт → tg_chat_id
// не привязался), со временем копятся в таблице. Чистим только НЕ подтверждённые
// через бота (tg_chat_id пуст) и НЕ те, что уже сработали (notified_at пуст) —
// история сработавших уведомлений не трогается.
const WATCH_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000; // неделя на то, чтобы открыть бота
async function cleanupStaleWatches() {
  try {
    const cutoff = new Date(Date.now() - WATCH_PENDING_TTL_MS).toISOString();
    const { error, count } = await supabaseAdmin
      .from('price_watchlist')
      .delete({ count: 'exact' })
      .eq('active', false)
      .is('tg_chat_id', null)
      .is('notified_at', null)
      .lt('created_at', cutoff);
    if (error) throw error;
    if (count) console.log(`[watchlist] cleaned up ${count} stale pending subscriptions`);
  } catch (e) {
    console.error('[watchlist] cleanup failed:', e.message);
  }
}

// =============================================================================
// СТАРТ
// =============================================================================

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🎮 Price Lookup Service`);
  console.log(`   Running on http://localhost:${PORT}`);
  console.log(`\n   Endpoints:`);
  console.log(`     GET  /health`);
  console.log(`     POST /api/price-lookup  { "gameName": "...", "platform": "PS4|PS5" }`);
  console.log(`\n   Test queries:`);
  TEST_QUERIES.forEach((q) => console.log(`     - ${q}`));
  console.log();
});

setInterval(checkWatchlist, 6 * 60 * 60 * 1000);
checkWatchlist(); // запустить сразу при старте, не ждать 6 часов
