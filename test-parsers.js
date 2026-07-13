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
  ['GTA V', 'gta 5'],
  ["Assassin's Creed", 'assassin s creed'],
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
