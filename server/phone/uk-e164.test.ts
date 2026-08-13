import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPlausibleUkE164, toE164Uk, toUkE164 } from './vapi-client.js';
import { normalizeDialableE164 } from './tools/leads.js';
import { normalizePhoneExport } from '../data-store.js';
import { chooseResearchedDialPhone } from '../sally/schedule-outbound.js';
import {
  applyColumnMapToRows,
  heuristicColumnMap,
} from '../ai/normalize-csv.js';

describe('toE164Uk / toUkE164', () => {
  it('fills missing UK geographic zero: 1296715055 ? +441296715055', () => {
    assert.equal(toE164Uk('1296715055'), '+441296715055');
    assert.equal(toUkE164('1296715055'), '+441296715055');
  });

  it('rewrites a wrongly prefixed +1296715055 into +441296715055', () => {
    assert.equal(toE164Uk('+1296715055'), '+441296715055');
    assert.equal(toUkE164('+1296715055'), '+441296715055');
  });

  it('converts a national mobile with leading 0', () => {
    assert.equal(toE164Uk('07700900123'), '+447700900123');
    assert.equal(toUkE164('07700900123'), '+447700900123');
  });

  it('fills missing UK mobile zero: 7700900123 ? +447700900123', () => {
    assert.equal(toUkE164('7700900123'), '+447700900123');
    assert.equal(toUkE164('+7700900123'), '+447700900123');
    assert.equal(normalizeDialableE164('7700900123'), '+447700900123');
  });

  it('leaves a valid +44 E.164 unchanged', () => {
    assert.equal(toE164Uk('+447700900123'), '+447700900123');
    assert.equal(toUkE164('+447700900123'), '+447700900123');
  });
});

describe('normalizePhone / normalizeDialableE164 UK missing-zero', () => {
  it('treats 10-digit geographic as 44', () => {
    assert.equal(normalizePhoneExport('1296715055'), '441296715055');
    assert.equal(normalizeDialableE164('1296715055'), '+441296715055');
    assert.equal(normalizeDialableE164('+1296715055'), '+441296715055');
  });
});

describe('chooseResearchedDialPhone', () => {
  it('dials +441296715055 when sheet is +1296715055 and listing is 01296 715055', () => {
    const chosen = chooseResearchedDialPhone('+1296715055', '01296 715055');
    assert.equal(chosen.dialTo, '+441296715055');
    assert.equal(chosen.sheetE164, '+441296715055');
    assert.equal(chosen.researchE164, '+441296715055');
    assert.equal(chosen.usedResearch, false);
  });

  it('uses the public listing when the sheet number is undialable', () => {
    const chosen = chooseResearchedDialPhone('123', '01296 715055');
    assert.equal(chosen.usedResearch, true);
    assert.equal(chosen.dialTo, '+441296715055');
  });

  it('uses the public listing when E.164 values disagree', () => {
    const chosen = chooseResearchedDialPhone('+441212345678', '01296 715055');
    assert.equal(chosen.usedResearch, true);
    assert.equal(chosen.dialTo, '+441296715055');
  });

  it('uses the public listing when the sheet has the wrong country code', () => {
    const chosen = chooseResearchedDialPhone('+331296715055', '01296 715055');
    assert.equal(chosen.usedResearch, true);
    assert.equal(chosen.dialTo, '+441296715055');
    assert.equal(isPlausibleUkE164('+331296715055'), false);
  });
});

describe('heuristic CSV column map + local E.164', () => {
  it('maps company_name / phone and converts Winslow missing-zero', () => {
    const headers = ['company_name', 'phone', 'address'];
    const map = heuristicColumnMap(headers);
    assert.equal(map.restaurant, 'company_name');
    assert.equal(map.phone, 'phone');
    const rows = applyColumnMapToRows(
      headers,
      [['The Crown', '1296715055', 'Market Square, Winslow MK18']],
      map,
      { defaultContact: 'Manager' },
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].restaurant, 'The Crown');
    assert.equal(rows[0].contact, 'Manager');
    assert.equal(rows[0].phoneE164, '+441296715055');
    assert.equal(rows[0].phoneNeedsResearch, false);
    assert.equal(rows[0].address, 'Market Square, Winslow MK18');
  });

  it('flags empty or implausible phones for research and leaves contact null without default', () => {
    const headers = ['company_name', 'phone'];
    const map = heuristicColumnMap(headers);
    const rows = applyColumnMapToRows(
      headers,
      [['Chippy', ''], ['Chippy', '12']],
      map,
    );
    assert.equal(rows[0].contact, null);
    assert.equal(rows[0].phoneNeedsResearch, true);
    assert.equal(rows[0].phoneE164, '');
    assert.equal(rows[1].phoneNeedsResearch, true);
  });
});
