// Captcha/bot-wall heuristic for the structured-extraction stage.
//
// isCaptchaWall(body) flags short HTML bodies containing block-page keywords
// (captcha / robot check / access denied / …). extractStructured (index.ts)
// short-circuits on a positive signal and reports a "captcha_wall" coverage gap.

const KEYWORDS = /captcha|robot check|are you human|access denied|pardon our interruption/i;
const SIZE_THRESHOLD = 10_000;

export function isCaptchaWall(body: string): boolean {
  return body.length < SIZE_THRESHOLD && KEYWORDS.test(body);
}
