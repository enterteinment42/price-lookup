/**
 * Чистые функции парсинга PS Store.
 *
 * Никаких HTTP, никакого Express. Только: HTML → структурированные данные.
 * Тестируется на сохранённых HTML-файлах из папки recon/.
 *
 * Что отсюда экспортируется:
 *   - parseSearchPage(html, region)  — парсит __NEXT_DATA__ страницы поиска
 *   - parsePriceText(text, currency) — парсит "1.145,00 TL" / "Rs 4,304" / "Free" / "Unavailable"
 *   - matchGame(query, candidates, opts) — фильтр по платформе/типу + fuzzy match + выбор минимума
 *   - normalizeQuery(s)              — lowercase, trim, римские → арабские
 *   - similarity(a, b)               — Sørensen–Dice по биграммам
 */

// =============================================================================
// КОНСТАНТЫ
// =============================================================================

/**
 * Какие классификации товаров PS Store считаем "играми".
 * GAME_BUNDLE — спорный, может быть как Ultimate Edition (наш), так и мусором.
 * Полагаемся на fuzzy matching по имени чтобы отфильтровать мусор.
 */
const GAME_CLASSIFICATIONS = new Set([
  'FULL_GAME',
  'GAME_BUNDLE',
  'PREMIUM_EDITION',
  'COMPLETE_GAME',
  'DIGITAL_EDITION',
  'DIGITAL_EXCLUSIVE_GAME',
  'PS5_NATIVE_GAME',
  'CROSS_GEN_BUNDLE',
]);

/**
 * Какие классификации точно отбрасываем (DLC, скины, машины, демо).
 * Перечислены явно для документирования что мы видели в реальных данных.
 */
const NON_GAME_CLASSIFICATIONS = new Set([
  'ADD_ON_PACK',
  'VEHICLE',
  'COSTUME',
  'OTHER',
  'DEMO',
  'THEME',
]);

/**
 * Апгрейд-товары («Marvel's Wolverine Digital Deluxe Edition Upgrade»).
 * Sony помечает их GAME_BUNDLE — то есть по classification они неотличимы от
 * настоящих Ultimate-изданий и проходят фильтр «только игры». По сути это DLC:
 * бесполезны без базовой игры и стоят копейки (Wolverine: 400 TL против 3449 TL
 * за саму игру), поэтому всегда выигрывали выбор минимальной цены среди изданий
 * и клиенту уходила цена в разы ниже реальной. Отсекаем по имени.
 */
const UPGRADE_RE = /\bupgrade\b/;

// =============================================================================
// ПАРСЕРЫ ЦЕН
// =============================================================================

/**
 * Универсальный парсер цены. Понимает все форматы которые встречаются в данных:
 *   - "1.145,00 TL"     → 1145.00 (Турция)
 *   - "₹1,49,999.00"    → 149999.00 (Индия классика)
 *   - "Rs 4,304"        → 4304 (Индия в результатах поиска — без копеек)
 *   - "Rs 0"            → 0
 *   - "0,00 TL"         → 0
 *   - "Free"            → 0
 *   - "Unavailable"     → null
 *   - "Not available"   → null
 *   - null/undefined/"" → null
 *
 * Возвращает:
 *   - число ≥ 0 если цена есть (включая 0 для бесплатных)
 *   - null если товар недоступен / цены нет
 */
export function parsePriceText(text, currency) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null;

  // Маркеры недоступности
  if (/^(unavailable|not\s+available|coming\s+soon)$/i.test(s)) return null;

  // Free — это валидная цена 0
  if (/^free$/i.test(s)) return 0;

  if (currency === 'TRY' || /TL\b|₺/.test(s)) {
    // Турция: "1.145,00 TL", "0,00 TL", "₺1.145,00"
    // Точки = разделители тысяч, запятая = десятичный
    const m = s.match(/₺\s*(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)/) || s.match(/(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)\s*TL/i);
    if (!m) return null;
    return parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
  }

  if (currency === 'INR' || /₹|Rs\b/i.test(s)) {
    // Индия: "₹1,499.00", "Rs 4,304", "Rs 0"
    // Запятые = разделители (индийская система с лакхами), точка = десятичный
    const m = s.match(/(?:₹|Rs)\s*([\d,]+(?:\.\d{2})?)/i);
    if (!m) return null;
    return parseFloat(m[1].replace(/,/g, ''));
  }

  return null;
}

// =============================================================================
// НОРМАЛИЗАЦИЯ ЗАПРОСА И FUZZY MATCH
// =============================================================================

/**
 * Нормализует запрос для сравнения:
 *   - lowercase, trim
 *   - убираем диакритику (é → e)
 *   - римские → арабские (GTA V → GTA 5)
 *   - убираем пунктуацию и лишние пробелы
 *
 * Не трогаем кириллицу — она нормально сравнивается с латиницей через биграммы
 * (а PSN сам умеет в кросс-язычный поиск, доверяемся ему больше).
 */
export function normalizeQuery(s) {
  if (!s) return '';
  let r = String(s).toLowerCase().trim();
  // Снимаем диакритику
  r = r.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Апострофы убираем БЕЗ пробела (до общей чистки пунктуации): "Marvel's" → "marvels".
  // Пробел давал лишнее слово ("marvel s wolverine" — 3 вместо 2), из-за чего в
  // isEditionOfSameGame ложно срабатывало правило «≥3 слов → остаток подзаголовок»,
  // и заодно портил биграммное сходство тайтлам с апострофом (Assassin's, Tom Clancy's).
  r = r.replace(/['’‘`´]/g, '');
  // Римские → арабские (только в типичных контекстах: пробел/начало/конец)
  // x исключён намеренно: слишком амбивалентен ("X-Men" → "10 men", "XCOM" — риск),
  // тогда как v однозначен в игровых тайтлах (GTA V, Street Fighter V, Battlefield V)
  r = r.replace(/\b(viii|vii|vi|iv|ix|xi|xii|v|iii|ii|i)\b/g, (m) => {
    const map = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', xi: '11', xii: '12' };
    return map[m] || m;
  });
  // Убираем пунктуацию (кроме цифр и букв), нормализуем пробелы
  r = r.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  // Раскрываем аббревиатуры популярных серий (после очистки пунктуации)
  // Добавляем пробел между буквой и цифрой: "FC26" → "fc 26", "FIFA26" → "fifa 26"
  r = r.replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2');
  // Раскрываем аббревиатуры популярных серий
  const ABBR = { gta: 'grand theft auto', rdr: 'red dead redemption', nfs: 'need for speed', cod: 'call of duty', tlou: 'the last of us', fifa: 'ea sports fc' };
  r = r.replace(/\b([a-z]+)\b/g, (w) => ABBR[w] || w);
  return r;
}

/**
 * Sørensen–Dice по биграммам. От 0 до 1.
 */
export function similarity(a, b) {
  if (!a || !b) return 0;
  a = a.toLowerCase().trim();
  b = b.toLowerCase().trim();
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };

  const A = bigrams(a);
  const B = bigrams(b);
  let intersection = 0;
  for (const bg of A) if (B.has(bg)) intersection++;
  return (2 * intersection) / (A.size + B.size);
}

/**
 * Грубая транслитерация кириллицы в латиницу (PL-31).
 * Нужна для trustTop-режима: similarity() между кириллическим запросом и
 * латинским именем игры всегда 0 (биграммы не пересекаются), поэтому в имени
 * из PS Store сравнивать не с чем. Транслитерация даёт хоть какой-то латинский
 * сигнал: "резидент ивел" → "rezident ivel" ≈ "resident evil" по биграммам.
 * Транслитерация фонетическая и неточная (з→z, а в англ. "resident" это s) —
 * поэтому используется только для переранжирования и с заниженными порогами.
 */
const CYR_LAT = {
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z',
  'и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
  'с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'sch',
  'ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
};
export function translitCyrillic(s) {
  return String(s || '').toLowerCase().replace(/[а-яё]/g, (ch) => CYR_LAT[ch] ?? ch);
}

// =============================================================================
// ПАРСЕР СТРАНИЦЫ ПОИСКА
// =============================================================================

/**
 * Парсит HTML страницы поиска PS Store. Возвращает массив кандидатов.
 *
 * Структура страницы:
 *   <script id="__NEXT_DATA__">{...}</script>
 *   В JSON: props.apolloState — нормализованный Apollo store, в нём:
 *     - ROOT_QUERY.universalSearch(...).results = [{__ref: "Product:..."}]
 *     - Product:ID:locale = {name, platforms, price, storeDisplayClassification, ...}
 *
 * region — 'tr' или 'in', влияет на трактовку цен
 *
 * Возвращает массив:
 *   [{
 *     id, name, platforms, classification,
 *     basePriceLocal, discountedPriceLocal, discountText,
 *     currency, isFree, isUnavailable
 *   }]
 */
// Достаёт URL обложки из media товара PS Store.
// media — массив { type, role, url } (иногда __ref на apolloState).
// 0 лишних запросов: данные уже в распарсенной странице поиска.
const COVER_ROLE_PRIORITY = ['PORTRAIT_BANNER', 'MASTER', 'GAMEHUB_COVER_ART'];
function pickCover(media, apollo) {
  if (!Array.isArray(media)) return null;
  const items = media
    .map((m) => (m && m.__ref ? apollo[m.__ref] : m))
    .filter((m) => m && m.url && (!m.type || m.type === 'IMAGE'));
  if (items.length === 0) return null;
  for (const role of COVER_ROLE_PRIORITY) {
    const hit = items.find((m) => m.role === role);
    if (hit) return hit.url;
  }
  return items[0].url;
}

export function parseSearchPage(html, region) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) {
    throw new Error('__NEXT_DATA__ not found on page');
  }
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`__NEXT_DATA__ JSON parse failed: ${e.message}`);
  }

  const apollo = data?.props?.apolloState;
  if (!apollo) {
    throw new Error('apolloState not found in __NEXT_DATA__');
  }

  // Ищем ключ universalSearch (включает параметры запроса, поэтому ищем по префиксу)
  const rootQuery = apollo.ROOT_QUERY || {};
  const searchKey = Object.keys(rootQuery).find((k) => k.startsWith('universalSearch'));
  if (!searchKey) {
    // Не падаем — поиск мог не вернуть ничего
    return [];
  }

  const results = rootQuery[searchKey]?.results || [];
  const currency = region === 'tr' ? 'TRY' : 'INR';

  const candidates = [];
  for (const ref of results) {
    const refKey = ref?.__ref;
    if (!refKey) continue;
    const item = apollo[refKey];
    if (!item || item.__typename !== 'Product') continue;

    const price = item.price || {};
    const basePriceLocal = parsePriceText(price.basePrice, currency);
    const discountedPriceLocal = parsePriceText(price.discountedPrice, currency);

    candidates.push({
      id: item.id || null,
      name: item.name || '',
      coverUrl: pickCover(item.media, apollo),
      platforms: Array.isArray(item.platforms) ? item.platforms : [],
      classification: item.storeDisplayClassification || null,
      // Цены: null если "Unavailable", 0 если "Free"
      basePriceLocal,
      discountedPriceLocal,
      // Эффективная цена для сравнения: discounted если есть, иначе base
      effectivePriceLocal:
        discountedPriceLocal != null ? discountedPriceLocal : basePriceLocal,
      discountText: price.discountText || null,
      isOnSale: !!(
        price.discountText &&
        discountedPriceLocal != null &&
        basePriceLocal != null &&
        discountedPriceLocal < basePriceLocal
      ),
      currency,
      isFree: price.isFree === true || basePriceLocal === 0,
      isUnavailable: basePriceLocal == null && discountedPriceLocal == null,
    });
  }

  return candidates;
}

// =============================================================================
// MATCHER
// =============================================================================

/**
 * Главная функция: из массива кандидатов выбирает релевантные и лучший.
 *
 * Делает:
 *   1. Фильтрует по classification — только игры
 *   2. Фильтрует по платформе (если задана)
 *   3. Отбрасывает Unavailable и (опционально) Free
 *   4. Считает схожесть имени с запросом
 *   5. Группирует по порогам: автомат ≥0.85 / серая зона / не нашли
 *   6. Выбирает минимум по effectivePriceLocal среди автоматических
 *
 * Параметры opts:
 *   platform: 'PS4' | 'PS5' | undefined — если задана, фильтруем по ней
 *   autoThreshold: 0.85 по умолчанию (для кириллицы можно понизить)
 *   greyThreshold: 0.5 по умолчанию
 *   includeFree: false (исключаем бесплатные «тематические бандлы»)
 *
 * Возвращает:
 *   { status: 'found', best, alternatives }
 *   { status: 'ambiguous', candidates }  // 0.5–autoThreshold
 *   { status: 'not_found' }
 */
const EDITION_SUFFIX_WORDS = new Set([
  'edition', 'ultimate', 'deluxe', 'complete', 'premium', 'digital',
  'special', 'enhanced', 'definitive', 'bundle', 'collection', 'plus',
  'gold', 'platinum', 'standard', 'anniversary', 'legacy', 'remastered',
  'hd', 'director', 'directors', 'goty', 'year', 'game', 'of', 'the',
  'and', 'pack', 'content', 'season', 'pass', 'expanded', 'extended',
  // платформенные суффиксы: "(PS5)", "(PS4 & PS5)" → после нормализации "ps 5", "ps 4"
  'ps', 'xbox', 'pc', 'cross', 'gen', 'next', 'native', 'version',
]);

// Проверяет: name — это издание той же игры что query?
// "cyberpunk 2077 ultimate edition" vs "cyberpunk 2077" → true (edition-слова)
// "the witcher 3 wild hunt" vs "the witcher 3" → true (query ≥3 слов → подзаголовок)
// "alien isolation" vs "alien" → false (query 1 слово, "isolation" не edition-слово)
// strict=true отключает правило «≥3 слов → подзаголовок» — нужно, когда сравниваются
// два ПОЛНЫХ имени товаров (trustTop), а не пользовательский запрос с именем:
// иначе "god of war ragnarok" сошёл бы за издание "god of war".
function isEditionOfSameGame(queryNorm, nameNorm, strict = false) {
  if (nameNorm === queryNorm) return true;
  if (!nameNorm.startsWith(queryNorm + ' ') && !nameNorm.startsWith(queryNorm + ':')) return false;
  const remainder = nameNorm.slice(queryNorm.length).replace(/^[\s:]+/, '');
  if (!remainder) return true;
  // Остаток состоит только из edition-слов или цифр → то же издание
  if (remainder.split(/\s+/).every(p => /^\d+$/.test(p) || EDITION_SUFFIX_WORDS.has(p))) return true;
  if (strict) return false;
  // Запрос из ≥3 слов достаточно специфичен: остаток — подзаголовок самой игры
  // ("The Witcher 3 Wild Hunt", "God of War Ragnarok"), а не другая игра серии
  return queryNorm.split(/\s+/).length >= 3;
}

// PL-23: из кандидатов-соседей оставляет только настоящие издания игры best.
// Соседние результаты поиска Sony — не обязательно издания того же тайтла; без
// фильтра чужая дешёвая игра попадала в ценовой пул lookupPrice и могла победить
// как «минимальная цена» с чужим названием. Сравниваем в обе стороны (Deluxe после
// Standard и наоборот), strict — чтобы «god of war ragnarok» не сошёл за издание
// «god of war».
function trustTopEditions(best, others) {
  const bestNorm = normalizeQuery(best.name);
  return others.filter((c) => {
    const nameNorm = normalizeQuery(c.name);
    return isEditionOfSameGame(bestNorm, nameNorm, true) || isEditionOfSameGame(nameNorm, bestNorm, true);
  }).slice(0, 3);
}

export function matchGame(query, candidates, opts = {}) {
  const {
    platform,
    autoThreshold = 0.85,
    greyThreshold = 0.5,
    includeFree = false,
    trustTop = false, // для кириллических запросов: доверяем позиции в PS Store, пропускаем Dice
  } = opts;

  const queryNorm = normalizeQuery(query);
  // Если клиент сам ищет апгрейд — не мешаем ему; иначе апгрейды отсекаем (см. UPGRADE_RE)
  const queryWantsUpgrade = UPGRADE_RE.test(queryNorm);

  // 1+2+3: первичная фильтрация
  const eligible = candidates.filter((c) => {
    if (!GAME_CLASSIFICATIONS.has(c.classification)) return false;
    if (!queryWantsUpgrade && UPGRADE_RE.test(normalizeQuery(c.name))) return false;
    if (c.isUnavailable) return false;
    if (!includeFree && c.isFree) return false;
    if (platform && c.platforms.length > 0 && !c.platforms.includes(platform)) return false;
    return true;
  });

  // Если trustTop — PS Store сам обработал перевод/аббревиатуры кириллицы.
  if (trustTop) {
    if (eligible.length === 0) return { status: 'not_found' };

    // PL-31: раньше слепо брали eligible[0]. Но сырой кириллический поиск Sony
    // возвращает не пустой список, а несколько слабых совпадений, и первое из них
    // могло оказаться чужой игрой ("резидент ивел 4" → "4PGP") — клиенту уверенно
    // показывалась чужая цена. Транслитерируем запрос в латиницу и переранжируем
    // кандидатов по биграммному сходству — берём лучший по сходству, а не первый
    // по позиции Sony. Если сигнала нет — не выдаём found вслепую.
    const qLat = normalizeQuery(translitCyrillic(query));

    // Транслитерация ничего не дала (запрос без кириллических букв дошёл сюда) —
    // сохраняем прежнее поведение: доверяем позиции Sony.
    if (!qLat) {
      const best = eligible[0];
      return { status: 'found', best, alternatives: trustTopEditions(best, eligible.slice(1)) };
    }

    const rescored = eligible
      .map((c, i) => ({ c, i, sim: similarity(qLat, normalizeQuery(c.name)) }))
      .sort((a, b) => b.sim - a.sim || a.i - b.i); // при равном сходстве — позиция Sony
    const topSim = rescored[0].sim;

    // Пороги занижены и эвристические: транслитерация фонетическая и неточная,
    // ждать высокого Dice-сходства нельзя. Уверенный матч → found; слабый сигнал →
    // ambiguous (пусть клиент выберет, а не мы угадываем); нулевой → not_found
    // (честная заявка менеджеру лучше уверенно неправильной цены).
    const TRUST_CONF = 0.45;
    const TRUST_GREY = 0.28;

    if (topSim >= TRUST_CONF) {
      const best = rescored[0].c;
      return { status: 'found', best, alternatives: trustTopEditions(best, rescored.slice(1).map(r => r.c)) };
    }
    if (topSim >= TRUST_GREY) {
      return { status: 'ambiguous', candidates: rescored.slice(0, 5).map(r => r.c) };
    }
    return { status: 'not_found' };
  }

  // 4: считаем схожесть
  // Heuristic: если имя кандидата начинается с запроса (или содержит его как
  // отдельное слово) — это та же игра, просто edition. Поднимаем similarity до 1.0,
  // иначе "Cyberpunk 2077: Ultimate Edition" проиграет "Cyberpunk 2077" по биграммам
  // и не попадёт в auto-корзину, хотя это явно тот же тайтл.
  const scored = eligible.map((c) => {
    const nameNorm = normalizeQuery(c.name);
    let sim = similarity(queryNorm, nameNorm);
    // Полное вхождение запроса как префикс или как слово в имени → автомат.
    // Доп. условие: запрос должен покрывать ≥40% слов результата —
    // иначе "cyberpunk" буcтит "Jigsaw Abundance cyberpunk bundle" наравне с "Cyberpunk 2077".
    const qWords = queryNorm.split(/\s+/).length;
    const nWords = nameNorm.split(/\s+/).length;
    // Имя начинается с запроса → та же игра, просто другое издание. Буст без проверки покрытия.
    // Если запрос встречается в середине — требуем покрытие ≥40% (защита от Jigsaw-бага).
    const isPrefix = (
      nameNorm === queryNorm ||
      nameNorm.startsWith(queryNorm + ' ') ||
      nameNorm.startsWith(queryNorm + ':')
    );
    const isWordInMiddle = !isPrefix &&
      new RegExp(`(^|\\s)${queryNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$|:)`).test(nameNorm);
    if (
      queryNorm.length >= 3 &&
      (isPrefix || (isWordInMiddle && qWords / nWords >= 0.4))
    ) {
      sim = Math.max(sim, 1.0);
    }
    return { ...c, similarity: sim };
  });

  // 5: распределение по корзинам
  const auto = scored.filter((c) => c.similarity >= autoThreshold);
  const grey = scored.filter((c) => c.similarity >= greyThreshold && c.similarity < autoThreshold);

  // 6: если есть автоматические — выбираем лучший вариант
  if (auto.length > 0) {
    const sortedByPrice = [...auto].sort(
      (a, b) => (a.effectivePriceLocal ?? Infinity) - (b.effectivePriceLocal ?? Infinity)
    );

    // Все авто-кандидаты — издания одной игры → берём дешевейшее, возвращаем все для cross-region
    const allSameGame = auto.every(c => isEditionOfSameGame(queryNorm, normalizeQuery(c.name)));
    if (allSameGame) {
      return {
        status: 'found',
        best: sortedByPrice[0],
        alternatives: sortedByPrice.slice(1),
      };
    }

    // Разные игры совпали с запросом → предлагаем выбор (до 5)
    const sortedBySim = [...auto].sort((a, b) =>
      b.similarity - a.similarity || (a.effectivePriceLocal ?? Infinity) - (b.effectivePriceLocal ?? Infinity)
    );
    return {
      status: 'ambiguous',
      candidates: sortedBySim.slice(0, 5),
    };
  }

  // Серая зона — топ-5 ближайших по схожести
  if (grey.length > 0) {
    const sorted = [...grey].sort((a, b) => b.similarity - a.similarity).slice(0, 5);
    return {
      status: 'ambiguous',
      candidates: sorted,
    };
  }

  return { status: 'not_found' };
}
