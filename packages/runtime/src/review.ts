import type { Run } from '../../contracts/src/index.js';
import { parseReviewReport } from '../../contracts/src/review.js';
export function reviewVerdict(text: string): Run['reviewVerdict'] { return parseReviewReport(text)?.verdict || null; }
