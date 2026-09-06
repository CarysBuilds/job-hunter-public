export type JobSource = 'boss' | 'liepin' | 'zhaopin';
export type Grade = 'A' | 'B' | 'C' | 'D';
export type ScoringMode = 'rules' | 'rules+llm';
export type LifecycleStatus = 'active' | 'archived';
export type CompanyType = 'unknown' | 'foreign' | 'listed' | 'mature' | 'startup' | 'outsourcing';
export type CompanyWorkLife = 'unknown' | 'weekends' | 'big_small_week' | 'single_day_off' | 'overtime_risk';
export type ContactStatus = 'unprocessed' | 'drafted' | 'greeted' | 'ready_to_apply' | 'applied' | 'interviewing' | 'rejected' | 'closed' | 'follow_up';
export type ContactOutcome = 'offer' | 'accepted' | 'rejected' | 'withdrawn' | 'no_response';
export type ContactCommunicationSource = 'manual' | 'legacy_unverified';
export type CareerStage = 'internship' | 'new_grad' | 'experienced' | 'career_change';
export type StrategyTemplate = 'general' | 'custom';
export type SalesRiskTolerance = 'avoid' | 'balanced' | 'accept';
export type JobTrack =
  | 'ai_application'
  | 'ai_solutions'
  | 'ai_product'
  | 'ai_customer_success'
  | 'algorithm_research'
  | 'pure_sales'
  | 'product'
  | 'engineering'
  | 'operations'
  | 'design'
  | 'data'
  | 'consulting'
  | 'customer_service'
  | 'other';

export interface RawJob {
  title: string;
  company: string;
  salary: string;
  location: string;
  source: JobSource;
  url: string;
  jd_fulltext: string;
  experience?: string;
  education?: string;
  tags?: string[];
  recruiter_name?: string;
  recruiter_title?: string;
  is_headhunter?: boolean;
  company_industry?: string;
  company_stage?: string;
  company_scale?: string;
  crawl_observation?: CrawlObservationMetadata;
}

export type CrawlDetailStatus = 'full' | 'reused' | 'list_fallback' | 'missing' | 'not_requested';

export interface CrawlObservationMetadata {
  platformJobId?: string;
  keyword?: string;
  city?: string;
  page?: number;
  rank?: number;
  detailStatus?: CrawlDetailStatus;
  duplicateHint?: boolean;
}

export interface ScoreEvidence {
  category: 'role' | 'capability' | 'threshold' | 'condition' | 'quality' | 'company' | 'risk';
  text: string;
}

export interface ScoreDimensions {
  role_fit: number;
  capability_fit: number;
  threshold_fit: number;
  condition_fit: number;
  opportunity_quality: number;
  company_quality: number;
  risk_penalty: number;
}

export interface CompanyProfileSource {
  query: string;
  title: string;
  url: string;
  description: string;
  hostname?: string;
}

export interface CompanyProfile {
  company_key: string;
  display_name: string;
  quality_score: number;
  company_type: CompanyType;
  work_life: CompanyWorkLife;
  reputation_summary: string;
  green_flags: string[];
  red_flags: string[];
  sources: CompanyProfileSource[];
  confidence: number;
  researched_at: string;
  expires_at: string;
  last_error?: string;
}

export interface JobContact {
  job_id: string;
  status: ContactStatus;
  greeted_at?: string;
  ready_to_apply_at?: string;
  applied_at?: string;
  interviewing_at?: string;
  platform?: JobSource;
  last_message?: string;
  next_follow_up_at?: string;
  notes?: string;
  outcome?: ContactOutcome;
  outcome_at?: string;
  communication_source?: ContactCommunicationSource;
  communication_verified_at?: string;
  updated_at: string;
}

export interface RequirementCheck {
  label: string;
  jd_requirement: string;
  candidate_evidence: string;
  status: 'met' | 'partial' | 'unmet' | 'unknown' | 'not_applicable';
  points: number;
  maximum: number;
}

export interface JobScore {
  total: number;
  interview_fit_score: number;
  job_match_score: number;
  company_quality_score: number;
  grade: Grade;
  track: JobTrack;
  dimensions: ScoreDimensions;
  matched_skills: string[];
  required_gaps: string[];
  insufficient_evidence: string[];
  red_flags: string[];
  green_flags: string[];
  evidence: ScoreEvidence[];
  summary: string;
  requirement_checks: RequirementCheck[];
  grade_cap_reasons: string[];
  sales_risk_level: 'none' | 'soft' | 'hard';
  score_version: 7;
  scoring_mode: ScoringMode;
}

export interface ScoredJob extends RawJob {
  id: string;
  company_key: string;
  score: JobScore;
  crawled_at: string;
  updated_at: string;
  first_seen_at: string;
  last_seen_at: string;
  lifecycle_status: LifecycleStatus;
  archived_at?: string;
  company_profile?: CompanyProfile;
  contact?: JobContact;
}

export interface CandidateProfile {
  schemaVersion: 1;
  profileVersion: number;
  updatedAt: string;
  strategyTemplate: StrategyTemplate;
  careerStage: CareerStage;
  targetTracks: JobTrack[];
  education: string;
  experienceYears: number;
  salaryFloorK: number;
  salaryExpectK: number;
  locationScore: Record<string, number>;
  salesRiskTolerance: SalesRiskTolerance;
  blockedCompanies: string[];
  blockedKeywords: string[];
}

export interface UserSettings {
  setupCompleted: boolean;
  cityCode: string;
  cities: string[];
  keywords: string[];
  platforms: Record<JobSource, boolean>;
  llm: {
    enabled: boolean;
    baseURL: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
  };
  publicMode: {
    draftedOnlyGreeting: boolean;
    batchGreetingEnabled: boolean;
  };
}

export interface SalaryRange {
  minK: number;
  maxK: number;
  months?: number;
}

export interface SemanticAnalysis {
  track: JobTrack;
  red_flags: string[];
  green_flags: string[];
  is_kitchen_sink: boolean;
  overtime_hint: boolean;
  has_sales_quota: boolean;
  is_fake_ai: boolean;
  evidence: string[];
  summary: string;
  capability_score: number;
  matched_skills: string[];
  required_gaps: string[];
  capability_evidence: string[];
}

export interface CrawlConfig {
  headless: boolean;
  pages: number;
  minSalary?: number;
  maxJobs?: number;
  delayMinMs: number;
  delayMaxMs: number;
  keywords: string[];
  authDir: string;
  diagnosticsDir: string;
  cdpPort: number;
  cdpPorts: Record<JobSource, number>;
  cityCode: string;
  cities: string[];
  adaptiveMinUnique: number;
}

export type RunOperation = 'crawl' | 'rescore';
export type RunState = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted' | 'cancelled';
export type RunFailureCategory = 'auth_required' | 'rate_limited' | 'page_structure' | 'configuration' | 'external_service' | 'data_processing' | 'worker_start' | 'worker_interrupted' | 'item_failure' | 'internal';

export interface CrawlRun {
  id: string;
  operation: RunOperation;
  status: RunState;
  source: JobSource | null;
  keywords: string[];
  pages: number;
  minSalary?: number;
  maxJobs?: number;
  currentPage: number;
  totalPages: number;
  found: number;
  saved: number;
  inserted: number;
  updated: number;
  reactivated: number;
  archived: number;
  deduplicated: number;
  message: string;
  error?: string;
  failureCategory?: RunFailureCategory;
  workerPid?: number;
  heartbeatAt?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
}

export interface CrawlRunPage {
  runId: string;
  ordinal: number;
  keyword: string;
  city: string;
  pageNumber: number;
  status: 'committed' | 'failed';
  rawCount: number;
  uniqueCount: number;
  saved: number;
  inserted: number;
  updated: number;
  deduplicated: number;
  detailFailed: number;
  errorMessage?: string;
  committedAt?: string;
}

export interface CrawlJobObservation {
  runId: string;
  ordinal: number;
  jobId?: string;
  source: JobSource;
  platformJobId?: string;
  keyword: string;
  city: string;
  pageNumber: number;
  rank: number;
  title: string;
  company: string;
  url: string;
  disposition: 'saved' | 'deduplicated' | 'salary_filtered' | 'limit_filtered' | 'score_failed';
  detailStatus: CrawlDetailStatus;
  observedAt: string;
}

export type SourceHealthStatus = 'healthy' | 'auth_required' | 'rate_limited' | 'partial' | 'drifted' | 'failed' | 'unknown';

export interface JobSourceHealth {
  source: JobSource;
  status: SourceHealthStatus;
  last_success_at?: string;
  last_failure_at?: string;
  last_error?: string;
  detail_missing_count: number;
  checked_at: string;
}

export type ApplicationEventType = 'applied' | 'recruiter_reply' | 'resume_requested' | 'screening' | 'assessment' | 'interview_scheduled' | 'interview_completed' | 'feedback' | 'offer' | 'accepted' | 'rejected' | 'withdrawn' | 'no_response';

export interface ApplicationEvent {
  id: string;
  job_id: string;
  type: ApplicationEventType;
  stage?: string;
  note?: string;
  reason_code?: string;
  occurred_at: string;
  idempotency_key: string;
  created_at: string;
}

export interface ContactFunnelStats {
  generated_at: string;
  stages: { ready_to_apply: number; applied: number; interviewing: number; outcome: number; positive_outcome: number };
  due_follow_ups: number;
  outcomes: Record<ContactOutcome, number>;
  conversion: { application_to_interview: number; interview_to_positive_outcome: number };
}

export interface JobContentVersion {
  id: string;
  job_id: string;
  origin: 'crawler' | 'detail_refresh' | 'manual_paste';
  content: string;
  content_hash: string;
  active: boolean;
  created_at: string;
}

export interface JobFilters {
  grade?: Grade[];
  source?: JobSource[];
  minSalary?: number;
  sort?: 'priority-desc' | 'score-desc' | 'salary-desc' | 'salary-asc' | 'fresh-desc';
  lifecycle?: LifecycleStatus | 'all';
  q?: string;
}

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
