'use strict';
const COUNTRIES = [
  ['US', 'United States'], ['CA', 'Canada'], ['GB', 'United Kingdom'], ['AU', 'Australia'], ['NZ', 'New Zealand'],
  ['IE', 'Ireland'], ['DE', 'Germany'], ['FR', 'France'], ['ES', 'Spain'], ['IT', 'Italy'], ['NL', 'Netherlands'],
  ['BE', 'Belgium'], ['AT', 'Austria'], ['CH', 'Switzerland'], ['SE', 'Sweden'], ['NO', 'Norway'], ['DK', 'Denmark'],
  ['FI', 'Finland'], ['PT', 'Portugal'], ['PL', 'Poland'], ['CZ', 'Czechia'], ['GR', 'Greece'], ['MX', 'Mexico'],
  ['BR', 'Brazil'], ['AR', 'Argentina'], ['CL', 'Chile'], ['CO', 'Colombia'], ['JP', 'Japan'], ['KR', 'South Korea'],
  ['SG', 'Singapore'], ['HK', 'Hong Kong'], ['IN', 'India'], ['ZA', 'South Africa'], ['AE', 'United Arab Emirates'],
  ['IL', 'Israel'],
];
const countryName = (code) => (COUNTRIES.find(([c]) => c === code) || [code, code])[1];
module.exports = { COUNTRIES, countryName };
