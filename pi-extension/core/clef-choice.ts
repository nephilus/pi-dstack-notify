import { held, record, strictJson } from './safety.ts';

/** Pure port of 715eef69 alert_selector._decision. No transport or policy selection. */
export interface ClefChoice {
  readonly type: 'choice';
  readonly choice: 'yes' | 'no';
  readonly probabilities: Readonly<{ yes: number; no: number }>;
  readonly confidence: number;
}
const unit = (value: unknown): value is number => typeof value === 'number'
  && Number.isFinite(value) && value >= 0 && value <= 1;
function invalid(): never { throw new Error('clef_choice_invalid'); }
export function validateClefChoice(response: unknown, expectedModel: string): ClefChoice {
  if (typeof expectedModel !== 'string' || !expectedModel || !record(response)
      || response.model !== expectedModel || !record(response.usage)
      || !Number.isInteger(response.usage.input_tokens) || response.usage.input_tokens <= 0
      || response.usage.input_tokens > 16384 || !Number.isInteger(response.usage.output_tokens)
      || response.usage.output_tokens !== 0 || !record(response.answers)
      || Object.keys(response.answers).length !== 1 || !Object.hasOwn(response.answers, 'publish')) invalid();
  const answer = response.answers.publish;
  if (!record(answer) || answer.type !== 'choice' || (answer.choice !== 'yes' && answer.choice !== 'no')
      || !record(answer.probabilities) || Object.keys(answer.probabilities).length !== 2
      || !Object.hasOwn(answer.probabilities, 'yes') || !Object.hasOwn(answer.probabilities, 'no')) invalid();
  const { yes, no } = answer.probabilities;
  if (!unit(yes) || !unit(no) || Math.abs(yes + no - 1) >= 0.002
      || answer.probabilities[answer.choice] < Math.max(yes, no) || !unit(answer.confidence)) invalid();
  // Provider metadata is accepted by the source validator, but not reflected.
  return Object.freeze({ type: 'choice', choice: answer.choice,
    probabilities: Object.freeze({ yes, no }), confidence: answer.confidence });
}
/** Pure JSON boundary; duplicate keys/depth/nonfinite handling shares the core scanner. */
export function parseClefChoiceJson(text: string, expectedModel: string): ClefChoice {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 262144) held();
    return validateClefChoice(strictJson(text), expectedModel);
  } catch { return invalid(); }
}
