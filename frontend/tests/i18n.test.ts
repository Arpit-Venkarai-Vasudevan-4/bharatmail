import assert from 'node:assert/strict';
import test from 'node:test';
import english from '../src/i18n/en.json';
import { formatDateTime, formatNumber, getLocale, loadLocale, validateCatalog } from '../src/i18n';
import { apiErrorText } from '../src/lib/api';

test('English UI catalog is complete and preserves interpolation tokens', () => {
  validateCatalog(english);
  assert.ok(Object.keys(english).length >= 600);
  const parameterized = Object.entries(english).find(([, value]) => value.includes('{'))!;
  const broken = { ...english, [parameterized[0]]: parameterized[1].replace(/\{[^}]+\}/, '{wrong}') };
  assert.throws(() => validateCatalog(broken), /Translation parameters differ/);
  assert.throws(() => validateCatalog({}), /Incomplete translation catalog/);
});

test('unsupported launch language is not selected and shared formatters follow the active locale', async () => {
  await loadLocale('en');
  const before = getLocale();
  assert.equal(await loadLocale('fr'), false);
  assert.equal(getLocale(), before);
  assert.equal(formatNumber(1234.5), new Intl.NumberFormat(before).format(1234.5));
  assert.equal(formatDateTime(0, { year: 'numeric', timeZone: 'UTC' }), new Intl.DateTimeFormat(before, { year: 'numeric', timeZone: 'UTC' }).format(0));
});

test('server error prose is never rendered directly; public error codes resolve through the English catalog', () => {
  const expected = english.m_5165840170d0;
  assert.equal(apiErrorText('VALIDATION_ERROR'), expected);
  assert.equal(apiErrorText('UNRECOGNIZED_FUTURE_CODE', 400), english.m_aec6e94a5c89);
  assert.notEqual(apiErrorText('VALIDATION_ERROR'), 'backend raw details');
});
