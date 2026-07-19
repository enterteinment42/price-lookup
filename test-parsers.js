/**
 * Тестируем парсеры на сохранённых HTML файлах из recon/.
 * Никаких HTTP-запросов — только локальные данные.
 */

import { readFileSync } from 'node:fs';
import {
  parseSearchPage,
  parsePriceText,
  normalizeQuery,
  similarity,
  matchGame,
} from './parsers.js';

const SEP = '─'.repeat(80);

// =============================================================================
// 1. Юнит-тесты parsePriceText
// =============================================================================
console.log('\n=== 1. parsePriceText ===');
const priceTests = [
  ['1.145,00 TL', 'TRY', 1145],
  ['2.799,00 TL', 'TRY', 2799],
  ['0,00 TL', 'TRY', 0],
  ['629,75 TL', 'TRY', 629.75],
  ['₹1,499.00', 'INR', 1499],
  ['₹1,49,999.00', 'INR', 149999],
  ['Rs 4,304', 'INR', 4304],
  ['Rs 0', 'INR', 0],
  ['Rs 1,664', 'INR', 1664],
  ['Free', 'TRY', 0],
  ['Unavailable', 'TRY', null],
  ['Not available', 'INR', null],
  ['', 'TRY', null],
  [null, 'INR', null],
];
let priceFails = 0;
for (const [input, cur, expected] of priceTests) {
  const got = parsePriceText(input, cur);
  const ok = got === expected;
  if (!ok) priceFails++;
  console.log(`  ${ok ? '✅' : '❌'}  parsePriceText(${JSON.stringify(input)}, '${cur}') → ${got}  ${ok ? '' : `(expected ${expected})`}`);
}
console.log(`  Итого: ${priceTests.length - priceFails}/${priceTests.length}`);

// =============================================================================
// 2. Юнит-тесты normalizeQuery
// =============================================================================
console.log('\n=== 2. normalizeQuery ===');
const normTests = [
  ['Cyberpunk 2077', 'cyberpunk 2077'],
  // ABBR-словарь разворачивает gta → grand theft auto (намеренно: нормализация
  // симметрична для запроса и имени кандидата, поэтому матчинг не страдает)
  ['GTA V', 'grand theft auto 5'],
  // Апостроф выпадает без пробела: "assassin s creed" давал лишнее слово (PL-32)
  ["Assassin's Creed", 'assassins creed'],
  ['Marvel’s Wolverine', 'marvels wolverine'],
  ['  Spider-Man  ', 'spider man'],
  ['Final Fantasy VII Remake', 'final fantasy 7 remake'],
  ['Ведьмак 3', 'ведьмак 3'],
  ['киберпанк', 'киберпанк'],
];
let normFails = 0;
for (const [input, expected] of normTests) {
  const got = normalizeQuery(input);
  const ok = got === expected;
  if (!ok) normFails++;
  console.log(`  ${ok ? '✅' : '❌'}  ${JSON.stringify(input)} → ${JSON.stringify(got)}  ${ok ? '' : `(expected ${JSON.stringify(expected)})`}`);
}
console.log(`  Итого: ${normTests.length - normFails}/${normTests.length}`);

// =============================================================================
// 2b. matchGame trustTop (PL-23) — alternatives только издания той же игры
// Синтетические кандидаты (не требует recon/): кириллический запрос вне словаря →
// trustTop. Чужая дешёвая игра из выдачи Sony НЕ должна попасть в alternatives,
// иначе lookupPrice покажет её цену и название как ответ.
// =============================================================================
console.log('\n=== 2b. matchGame trustTop (PL-23) ===');
const _tt = (name, cls, price) => ({
  name, classification: cls, platforms: ['PS5'],
  basePriceLocal: price, discountedPriceLocal: null, effectivePriceLocal: price,
  isFree: false, isUnavailable: false, currency: 'TRY',
});
const ttCandidates = [
  _tt('Hogwarts Legacy', 'FULL_GAME', 2999),
  _tt('Hogwarts Legacy: Digital Deluxe Edition', 'PREMIUM_EDITION', 3999),
  _tt('Peppa Pig: World Adventures', 'FULL_GAME', 199),          // чужая дешёвая игра
  _tt('Hogwarts Legacy 2', 'FULL_GAME', 4999),                   // цифра-сиквел — допустимое издание-исключение
];
const ttRes = matchGame('хогвартс легаси', ttCandidates, { trustTop: true });
const ttAltNames = (ttRes.alternatives || []).map((c) => c.name);
const ttTests = [
  ['status found', ttRes.status === 'found'],
  ['best = первый результат Sony', ttRes.best?.name === 'Hogwarts Legacy'],
  ['Deluxe в alternatives', ttAltNames.includes('Hogwarts Legacy: Digital Deluxe Edition')],
  ['Peppa Pig НЕ в alternatives', !ttAltNames.includes('Peppa Pig: World Adventures')],
];
let ttFails = 0;
for (const [label, ok] of ttTests) {
  if (!ok) ttFails++;
  console.log(`  ${ok ? '✅' : '❌'}  ${label}`);
}
console.log(`  alternatives: [${ttAltNames.join(' | ')}]`);
console.log(`  Итого: ${ttTests.length - ttFails}/${ttTests.length}`);

// =============================================================================
// 2d. matchGame — апгрейд-товары не участвуют в цене (PL-32)
// Живая выдача Sony по "Marvel's Wolverine": сама игра 3449 TL, Deluxe 3849 TL и
// "Digital Deluxe Edition Upgrade" 400 TL с classification GAME_BUNDLE. Апгрейд
// проходил фильтр «только игры» и выигрывал выбор минимальной цены → клиенту
// уходило ~1010 ₽ вместо реальной цены игры.
// =============================================================================
console.log('\n=== 2d. matchGame upgrade-фильтр (PL-32) ===');
const upCandidates = [
  _tt('Marvel’s Wolverine', 'FULL_GAME', 3449),
  _tt('Marvel’s Wolverine Digital Deluxe Edition', 'PREMIUM_EDITION', 3849),
  _tt('Marvel’s Wolverine Digital Deluxe Edition Upgrade', 'GAME_BUNDLE', 400),
];
const upRes = matchGame("Marvel's Wolverine", upCandidates, {});
const upAlt = (upRes.alternatives || []).map((c) => c.name);
// Клиент сам ищет апгрейд — фильтр не должен выбрасывать апгрейд из выдачи
// (found с ним или ambiguous с ним в списке — оба варианта приемлемы, в отличие от
// «апгрейда нет вообще»)
const upWanted = matchGame("Marvel's Wolverine Digital Deluxe Edition Upgrade", upCandidates, {});
const upWantedNames = [upWanted.best, ...(upWanted.alternatives || []), ...(upWanted.candidates || [])]
  .filter(Boolean).map((c) => c.name);
const upTests = [
  ['status found', upRes.status === 'found'],
  ['best = сама игра, не апгрейд', upRes.best?.name === 'Marvel’s Wolverine'],
  ['цена базовой игры, не 400', upRes.best?.effectivePriceLocal === 3449],
  ['апгрейд НЕ в alternatives', !upAlt.some((n) => /Upgrade/.test(n))],
  ['Deluxe остался в alternatives', upAlt.includes('Marvel’s Wolverine Digital Deluxe Edition')],
  ['явный запрос апгрейда не теряет апгрейд', upWantedNames.some((n) => /Upgrade/.test(n))],
];
let upFails = 0;
for (const [label, ok] of upTests) {
  if (!ok) upFails++;
  console.log(`  ${ok ? '✅' : '❌'}  ${label}`);
}
console.log(`  best="${upRes.best?.name}" (${upRes.best?.effectivePriceLocal})  alternatives=[${upAlt.join(' | ')}]`);
console.log(`  Итого: ${upTests.length - upFails}/${upTests.length}`);

// =============================================================================
// 2c. matchGame trustTop (PL-31) — переранжирование по транслит-сходству
// Сырой кириллический поиск Sony ставит чужую игру первой ("резидент ивел 4" →
// "4PGP"). Раньше брали eligible[0] слепо → клиенту уходила чужая цена/название.
// Теперь запрос транслитерируется и кандидаты переранжируются по сходству —
// best должен стать настоящей игрой, а не первым мусором Sony.
// =============================================================================
console.log('\n=== 2c. matchGame trustTop rerank (PL-31) ===');
// Кейс 1: правильная игра есть в выдаче, но не первой — должна победить.
const p31Candidates = [
  _tt('4PGP', 'FULL_GAME', 1990),                              // мусор, Sony ставит первым
  _tt('Resident Evil 4', 'FULL_GAME', 2999),
  _tt('Resident Evil 4: Deluxe Edition', 'PREMIUM_EDITION', 3999),
];
const p31Res = matchGame('резидент ивел 4', p31Candidates, { trustTop: true });
const p31Alt = (p31Res.alternatives || []).map((c) => c.name);
// Кейс 2: правильной игры в выдаче нет, только мусор — НЕ выдаём found вслепую.
const p31Junk = matchGame('абвгдеж', [
  _tt('4PGP', 'FULL_GAME', 1990),
  _tt('Peppa Pig: World Adventures', 'FULL_GAME', 199),
], { trustTop: true });
const p31Tests = [
  ['status found', p31Res.status === 'found'],
  ['best = Resident Evil 4 (не 4PGP)', p31Res.best?.name === 'Resident Evil 4'],
  ['4PGP НЕ в alternatives', !p31Alt.includes('4PGP')],
  ['Deluxe в alternatives', p31Alt.includes('Resident Evil 4: Deluxe Edition')],
  ['мусорный запрос → не found', p31Junk.status !== 'found'],
];
let p31Fails = 0;
for (const [label, ok] of p31Tests) {
  if (!ok) p31Fails++;
  console.log(`  ${ok ? '✅' : '❌'}  ${label}`);
}
console.log(`  best="${p31Res.best?.name}"  alternatives=[${p31Alt.join(' | ')}]  junk.status=${p31Junk.status}`);
console.log(`  Итого: ${p31Tests.length - p31Fails}/${p31Tests.length}`);

// =============================================================================
// 2e. matchGame — мульти-игровой бандл не роняет группу в ambiguous
// Живая выдача по "hogwarts legacy": базы «PS4/PS5 Version», Deluxe и бандл
// «Hogwarts Legacy + Harry Potter: Quidditch Champions…». Слова бандла — не
// edition-слова, и один такой кандидат ронял весь однозначный запрос в
// ambiguous. Бандл содержит саму игру → считается её изданием (isBundleWithGame).
// =============================================================================
console.log('\n=== 2e. matchGame бандл-как-издание (Hogwarts) ===');
const hwCandidates = [
  _tt('Hogwarts Legacy PS4 Version', 'FULL_GAME', 1499),
  _tt('Hogwarts Legacy PS5 Version', 'PS5_NATIVE_GAME', 1699),
  _tt('Hogwarts Legacy + Harry Potter: Quidditch Champions Deluxe Editions Bundle', 'GAME_BUNDLE', 2499),
  _tt('Hogwarts Legacy: Digital Deluxe Edition', 'PREMIUM_EDITION', 1999),
];
const hwRes = matchGame('hogwarts legacy', hwCandidates, {});
const hwAlt = (hwRes.alternatives || []).map((c) => c.name);
// Контроль: франшиза без «+» по-прежнему ambiguous — сиквелы не выбираем молча
const fcRes = matchGame('far cry', [
  _tt('Far Cry 6', 'FULL_GAME', 999),
  _tt('Far Cry Primal', 'FULL_GAME', 799),
], {});
const hwTests = [
  ['status found', hwRes.status === 'found'],
  ['best = дешевейшая база (PS4)', hwRes.best?.name === 'Hogwarts Legacy PS4 Version'],
  ['бандл В alternatives (издание, не мусор)', hwAlt.some((n) => n.includes('+'))],
  ['Deluxe в alternatives', hwAlt.includes('Hogwarts Legacy: Digital Deluxe Edition')],
  ['франшиза без «+» осталась ambiguous', fcRes.status === 'ambiguous'],
];
let hwFails = 0;
for (const [label, ok] of hwTests) {
  if (!ok) hwFails++;
  console.log(`  ${ok ? '✅' : '❌'}  ${label}`);
}
console.log(`  best="${hwRes.best?.name}" (${hwRes.best?.effectivePriceLocal})  alternatives=[${hwAlt.join(' | ')}]`);
console.log(`  Итого: ${hwTests.length - hwFails}/${hwTests.length}`);

// =============================================================================
// 3. parseSearchPage на реальных файлах
// =============================================================================
console.log('\n=== 3. parseSearchPage(search-tr.html) ===');
const trHtml = readFileSync('./recon/search-tr.html', 'utf-8');
const trCandidates = parseSearchPage(trHtml, 'tr');
console.log(`  Найдено кандидатов: ${trCandidates.length}`);
console.log('  Все позиции:');
console.log('  ' + 'name'.padEnd(46) + ' | ' + 'cls'.padEnd(15) + ' | ' + 'plat'.padEnd(8) + ' | ' + 'base'.padStart(8) + ' | ' + 'disc'.padStart(8) + ' | sale');
console.log('  ' + '─'.repeat(110));
for (const c of trCandidates) {
  const base = c.basePriceLocal == null ? '—' : c.basePriceLocal.toString();
  const disc = c.discountedPriceLocal == null ? '—' : c.discountedPriceLocal.toString();
  const sale = c.isOnSale ? `🔥${c.discountText}` : '';
  console.log(`  ${c.name.slice(0, 45).padEnd(46)} | ${(c.classification || '-').padEnd(15)} | ${c.platforms.join(',').padEnd(8)} | ${base.padStart(8)} | ${disc.padStart(8)} | ${sale}`);
}

console.log('\n=== 3b. parseSearchPage(search-in.html) ===');
const inHtml = readFileSync('./recon/search-in.html', 'utf-8');
const inCandidates = parseSearchPage(inHtml, 'in');
console.log(`  Найдено кандидатов: ${inCandidates.length}`);
console.log('  Все позиции:');
console.log('  ' + 'name'.padEnd(46) + ' | ' + 'cls'.padEnd(15) + ' | ' + 'plat'.padEnd(8) + ' | ' + 'base'.padStart(8) + ' | ' + 'disc'.padStart(8) + ' | sale');
console.log('  ' + '─'.repeat(110));
for (const c of inCandidates) {
  const base = c.basePriceLocal == null ? '—' : c.basePriceLocal.toString();
  const disc = c.discountedPriceLocal == null ? '—' : c.discountedPriceLocal.toString();
  const sale = c.isOnSale ? `🔥${c.discountText}` : '';
  console.log(`  ${c.name.slice(0, 45).padEnd(46)} | ${(c.classification || '-').padEnd(15)} | ${c.platforms.join(',').padEnd(8)} | ${base.padStart(8)} | ${disc.padStart(8)} | ${sale}`);
}

// =============================================================================
// 4. matchGame — основной сценарий: Cyberpunk 2077 на PS5
// =============================================================================
console.log('\n' + SEP);
console.log('=== 4. matchGame: "Cyberpunk 2077" + platform PS5 ===');
const matchPS5TR = matchGame('Cyberpunk 2077', trCandidates, { platform: 'PS5' });
console.log(`  TR status: ${matchPS5TR.status}`);
if (matchPS5TR.status === 'found') {
  const b = matchPS5TR.best;
  console.log(`  TR best: "${b.name}" — ${b.effectivePriceLocal} TRY (sim=${b.similarity.toFixed(2)})${b.isOnSale ? ` 🔥 ${b.discountText}` : ''}`);
  console.log(`  TR alts: ${matchPS5TR.alternatives.map((a) => `${a.name.slice(0, 30)} ${a.effectivePriceLocal} TRY`).join(' | ')}`);
}

const matchPS5IN = matchGame('Cyberpunk 2077', inCandidates, { platform: 'PS5' });
console.log(`  IN status: ${matchPS5IN.status}`);
if (matchPS5IN.status === 'found') {
  const b = matchPS5IN.best;
  console.log(`  IN best: "${b.name}" — ${b.effectivePriceLocal} INR (sim=${b.similarity.toFixed(2)})${b.isOnSale ? ` 🔥 ${b.discountText}` : ''}`);
  console.log(`  IN alts: ${matchPS5IN.alternatives.map((a) => `${a.name.slice(0, 30)} ${a.effectivePriceLocal} INR`).join(' | ')}`);
}

// =============================================================================
// 5. matchGame: Cyberpunk 2077 на PS4 — ключевой кейс! Не должен выбирать Ultimate
// =============================================================================
console.log('\n=== 5. matchGame: "Cyberpunk 2077" + platform PS4 (Ultimate PS5-only должен исчезнуть) ===');
const matchPS4TR = matchGame('Cyberpunk 2077', trCandidates, { platform: 'PS4' });
console.log(`  TR status: ${matchPS4TR.status}`);
if (matchPS4TR.status === 'found') {
  const b = matchPS4TR.best;
  console.log(`  TR best: "${b.name}" — ${b.effectivePriceLocal} TRY  platforms=${b.platforms.join(',')}`);
}

// =============================================================================
// 6. Что если платформа не задана? (вариант D — наивный минимум)
// =============================================================================
console.log('\n=== 6. matchGame: "Cyberpunk 2077" без platform — должен выбрать Ultimate ===');
const matchAny = matchGame('Cyberpunk 2077', trCandidates);
if (matchAny.status === 'found') {
  const b = matchAny.best;
  console.log(`  TR best: "${b.name}" — ${b.effectivePriceLocal} TRY platforms=${b.platforms.join(',')}`);
}

// =============================================================================
// 7. matchGame с кириллицей
// =============================================================================
console.log('\n=== 7. matchGame: "Киберпанк" с пониженным порогом для кириллицы ===');
const matchCyr = matchGame('Киберпанк', trCandidates, { platform: 'PS5', autoThreshold: 0.3 });
console.log(`  Status: ${matchCyr.status}`);
if (matchCyr.status === 'found') {
  console.log(`  Best: "${matchCyr.best.name}" sim=${matchCyr.best.similarity.toFixed(2)}`);
} else if (matchCyr.status === 'ambiguous') {
  console.log(`  Candidates: ${matchCyr.candidates.map((c) => `${c.name} (sim=${c.similarity.toFixed(2)})`).join(' | ')}`);
}

// =============================================================================
// 8. Сравнение TR vs IN — двухрегиональный выбор минимума (логика lookupPrice)
// =============================================================================
console.log('\n=== 8. Двухрегиональный выбор минимума (mock-курсы) ===');
const TRY_TO_RUB = 2.5;
const INR_TO_RUB = 1.0;
const MARKUP = 1.3;
const toRub = (price, cur) => {
  if (price == null) return null;
  const rate = cur === 'TRY' ? TRY_TO_RUB : INR_TO_RUB;
  return Math.round(price * rate * MARKUP);
};

console.log('  Платформа PS5:');
if (matchPS5TR.status === 'found') {
  const r = toRub(matchPS5TR.best.effectivePriceLocal, 'TRY');
  console.log(`    TR: ${matchPS5TR.best.effectivePriceLocal} TRY → ${r} ₽ (${matchPS5TR.best.name})`);
}
if (matchPS5IN.status === 'found') {
  const r = toRub(matchPS5IN.best.effectivePriceLocal, 'INR');
  console.log(`    IN: ${matchPS5IN.best.effectivePriceLocal} INR → ${r} ₽ (${matchPS5IN.best.name})`);
}

console.log('\n  Платформа PS4:');
if (matchPS4TR.status === 'found') {
  const r = toRub(matchPS4TR.best.effectivePriceLocal, 'TRY');
  console.log(`    TR: ${matchPS4TR.best.effectivePriceLocal} TRY → ${r} ₽ (${matchPS4TR.best.name})`);
}
const matchPS4IN = matchGame('Cyberpunk 2077', inCandidates, { platform: 'PS4' });
if (matchPS4IN.status === 'found') {
  const r = toRub(matchPS4IN.best.effectivePriceLocal, 'INR');
  console.log(`    IN: ${matchPS4IN.best.effectivePriceLocal} INR → ${r} ₽ (${matchPS4IN.best.name})`);
}
