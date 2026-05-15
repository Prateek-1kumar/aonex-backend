const KEYWORDS = /captcha|robot check|are you human|access denied|pardon our interruption/i;
const SIZE_THRESHOLD = 10_000;

export function isCaptchaWall(body: string): boolean {
  return body.length < SIZE_THRESHOLD && KEYWORDS.test(body);
}
