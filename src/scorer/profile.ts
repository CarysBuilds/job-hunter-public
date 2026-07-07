import { DEFAULT_CANDIDATE_PROFILE, loadCandidateProfile } from '../config.js';
import type { CandidateProfile } from '../types.js';

export const PUBLIC_DEFAULT_PROFILE: CandidateProfile = DEFAULT_CANDIDATE_PROFILE;

export function getCandidateProfile(): CandidateProfile {
  return loadCandidateProfile();
}
