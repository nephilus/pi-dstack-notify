import './offline-guard.mjs';
import { attempts } from './offline-guard.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseClefChoiceJson, validateClefChoice } from '../../core/clef-choice.ts';
const fixture = JSON.parse(readFileSync(new URL('../../fixtures/fyip-reference.json', import.meta.url), 'utf8'));
const model = fixture.clef.model;
after(() => { assert.deepEqual(attempts, []); assert.equal(process.env.PATH, '/nonexistent-notification-test-path'); });

test('accepted CURRENT Clef Choice envelope, yes/no and ties; confidence is not a threshold', () => {
  for (const choice of ['yes', 'no'] as const) for (const confidence of [0, 0.00001, 0.5, 1]) {
    const envelope = structuredClone(fixture.clef);
    Object.assign(envelope.answers.publish, { choice, confidence, probabilities: { yes: 0.5, no: 0.5 } });
    const result = validateClefChoice(envelope, model);
    assert.equal(result.choice, choice); assert.equal(result.confidence, confidence);
    assert.deepEqual(parseClefChoiceJson(JSON.stringify(envelope), model), result);
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.probabilities));
  }
});

test('reference metadata remains accepted but is not reflected or aliased', () => {
  const envelope = structuredClone(fixture.clef);
  envelope.extra = 'synthetic-private'; envelope.usage.extra = 1;
  envelope.answers.publish.extra = 'synthetic-private';
  const result = validateClefChoice(envelope, model);
  envelope.answers.publish.probabilities.yes = 0;
  assert.equal(result.probabilities.yes, 0.9);
  assert.ok(!JSON.stringify(result).includes('synthetic-private'));
});

test('strict model, usage, answer keys, type and exact selected label', () => {
  const mutations: Array<(v: any) => void> = [
    v => { v.model = 'other'; }, v => { delete v.model; }, v => { v.usage = null; },
    ...[true, 0, -1, 16385, 0.5, '100', NaN, Infinity].map(input => (v: any) => { v.usage.input_tokens = input; }),
    ...[true, false, 1, '0', NaN, Infinity].map(output => (v: any) => { v.usage.output_tokens = output; }),
    v => { v.answers.extra = v.answers.publish; }, v => { delete v.answers.publish; },
    v => { v.answers.publish = null; }, v => { v.answers.publish.type = 'text'; },
    ...['YES', 'no ', 'uncertain', true, null, { choice: 'no' }].map(choice => (v: any) => { v.answers.publish.choice = choice; }),
    v => { v.answers.publish.probabilities = { yes: 0.1, no: 0.9 }; },
  ];
  for (const mutate of mutations) {
    const envelope = structuredClone(fixture.clef); mutate(envelope);
    assert.throws(() => validateClefChoice(envelope, model), { message: 'clef_choice_invalid' });
  }
  for (const input of [null, [], 'no', true]) assert.throws(() => validateClefChoice(input, model));
  for (const input of [1, 16384]) {
    const envelope = structuredClone(fixture.clef); envelope.usage.input_tokens = input;
    assert.equal(validateClefChoice(envelope, model).choice, 'yes');
  }
});

test('finite unit probabilities/confidence, exact label set, source sum tolerance and argmax', () => {
  for (const probabilities of [null, [], { yes: true, no: 0 }, { yes: -0.1, no: 1.1 },
    { yes: NaN, no: 0 }, { yes: Infinity, no: 0 }, { yes: '0.9', no: 0.1 },
    { yes: 0.9 }, { yes: 0.9, no: 0.1, maybe: 0 }, { yes: 0.9, no: 0.2 },
    { yes: 0.5, no: 0.5021 }]) {
    const envelope = structuredClone(fixture.clef); envelope.answers.publish.probabilities = probabilities;
    assert.throws(() => validateClefChoice(envelope, model));
  }
  for (const confidence of [true, null, '0.9', -0.01, 1.01, NaN, Infinity]) {
    const envelope = structuredClone(fixture.clef); envelope.answers.publish.confidence = confidence;
    assert.throws(() => validateClefChoice(envelope, model));
  }
  for (const no of [0.0981, 0.1019]) {
    const envelope = structuredClone(fixture.clef); envelope.answers.publish.probabilities.no = no;
    assert.equal(validateClefChoice(envelope, model).choice, 'yes');
  }
});

test('JSON duplicate/nonfinite/truncated/depth/size guards wrap otherwise valid Choice data', () => {
  const valid = JSON.stringify(fixture.clef);
  const duplicate = '{"model":' + JSON.stringify(model) + ',' + valid.slice(1);
  assert.equal(validateClefChoice(JSON.parse(duplicate), model).choice, 'yes');
  const nonfiniteMetadata = '{"ignored_metadata":1e999,' + valid.slice(1);
  assert.equal(validateClefChoice(JSON.parse(nonfiniteMetadata),model).choice,'yes');
  assert.throws(() => parseClefChoiceJson(nonfiniteMetadata,model),{message:'clef_choice_invalid'});
  const deep = structuredClone(fixture.clef); let nested: unknown = 0;
  for (let i = 0; i < 34; i++) nested = [nested]; deep.extra = nested;
  assert.equal(validateClefChoice(deep, model).choice, 'yes');
  const sized = structuredClone(fixture.clef); sized.extra = '';
  const size = Buffer.byteLength(JSON.stringify(sized)); sized.extra = 'x'.repeat(262144 - size);
  assert.equal(parseClefChoiceJson(JSON.stringify(sized), model).choice, 'yes');
  sized.extra += 'x'; assert.equal(validateClefChoice(sized, model).choice, 'yes');
  for (const text of [duplicate, valid.slice(0, -1), valid.replace('100', '1e999'),
    JSON.stringify(deep), JSON.stringify(sized)])
    assert.throws(() => parseClefChoiceJson(text, model), { message: 'clef_choice_invalid' });
});
