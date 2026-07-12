export type JobSource = 'boss' | 'liepin' | 'zhaopin';
export type Grade = 'A' | 'B' | 'C' | 'D';
export type ScoringMode = 'rules' | 'rules+llm';
export type LifecycleStatus = 'active' | 'archived';
export type CompanyType = 'unknown' | 'foreign' | 'listed' | 'mature' | 'startup' | 'outsourcing';
export type CompanyWorkLife = 'unknown' | 'weekends' | 'big_small_week' | 'single_day_off' | 'overtime_risk';
export type ContactStatus = 'unprocessed' | 'drafted' | 'greeted' | 'applied' | 'interviewing' | 'rejected' | 'closed' | 'follow_up';
export type CareerStage = 'internship' | 'new_grad' | 'experienced' | 'career_change';
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
  platform?: JobSource;
  last_message?: string;
  next_follow_up_at?: string;
  notes?: string;
  updated_at: string;
}

export interface JobScore {
  total: number;
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
  score_version: 5;
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
  careerStage: CareerStage;
  targetTracks: JobTrack[];
  technicalGroups: Array<{ label: string; keywords: string[]; points: number }>;
  solutionGroups: Array<{ label: string; keywords: string[]; points: number }>;
  mismatchSkills: string[];
  education: string;
  experienceYears: number;
  salaryFloorK: number;
  salaryExpectK: number;
  locationScore: Record<string, number>;
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
}

export interface CrawlConfig {
  headless: boolean;
  pages: number;
  delayMinMs: number;
  delayMaxMs: number;
  keywords: string[];
  authDir: string;
  diagnosticsDir: string;
  cdpPort: number;
  cdpPorts: Record<JobSource, number>;
  cityCode: string;
  cities: string[];
}

export type RunOperation = 'crawl' | 'rescore';
export type RunState = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';

export interface CrawlRun {
  id: string;
  operation: RunOperation;
  status: RunState;
  source: JobSource | null;
  keywords: string[];
  pages: number;
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
  workerPid?: number;
  heartbeatAt?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
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
