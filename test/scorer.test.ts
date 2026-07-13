import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CandidateProfile, CompanyProfile, RawJob } from '../src/types.js';
import { scoreWithRules, parseSalary } from '../src/scorer/rules.js';
import { DEFAULT_CANDIDATE_PROFILE } from '../src/config.js';

const TEST_PROFILE: CandidateProfile = {
  ...DEFAULT_CANDIDATE_PROFILE,
  experienceYears: 8,
  salaryFloorK: 15,
  salaryExpectK: 20,
  locationScore: { 深圳: 5, 广州: 2, 珠海: 2 },
};

const TEST_RESUME = `本科，8 年工作经验。负责企业软件产品、AI 产品和大模型解决方案，完成需求分析、客户访谈、产品规划、PRD、原型设计、用户体验、PoC 演示、客户沟通、项目交付、培训、上线运营和复盘。熟悉 Agent、RAG、知识库、工作流、Dify、Python、TypeScript、Node.js、API 与数据分析。`;

function job(overrides: Partial<RawJob> = {}): RawJob {
  return {
    title: 'AI Agent应用开发工程师',
    company: '示例科技',
    salary: '20-35K·14薪',
    location: '深圳·南山区',
    source: 'boss',
    url: 'https://www.zhipin.com/job_detail/example.html',
    experience: '1-3年',
    education: '本科',
    tags: ['Agent', 'RAG', '本科'],
    jd_fulltext: `负责企业级 AI Agent 与 RAG 应用从0到1落地，使用 Python、Node.js、TypeScript、SQL 和 API 完成系统集成与自动化工作流。参与需求分析、解决方案与架构设计，完成 PoC 演示、客户沟通、项目交付和技术文档。需要理解 LangChain、Prompt、Dify 等大模型应用技术，并持续优化产品体验。`,
    ...overrides,
  };
}

function company(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    company_key: '示例科技',
    display_name: '示例科技',
    quality_score: 70,
    company_type: 'unknown',
    work_life: 'unknown',
    reputation_summary: '中性公司画像',
    green_flags: [],
    red_flags: [],
    sources: [],
    confidence: 0.5,
    researched_at: '2026-06-01T00:00:00.000Z',
    expires_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function scoreFor(raw: RawJob, companyProfile: CompanyProfile | null = null) {
  return scoreWithRules(raw, null, TEST_PROFILE, companyProfile, TEST_RESUME);
}

describe('个性化评分 v6', () => {
  it('编码岗位不再因固定候选人画像自动降档', () => {
    const score = scoreFor(job());
    assert.equal(score.track, 'ai_solutions');
    assert.equal(score.grade, 'B');
    assert.ok(score.total < 80);
    assert.equal(score.score_version, 6);
    assert.equal(score.company_quality_score, 70);
    assert.equal(score.scoring_mode, 'rules');
    assert.ok(score.matched_skills.includes('AI 应用'));
    assert.ok(score.matched_skills.includes('编程语言'));
    assert.equal(score.red_flags.some((flag) => flag.includes('编码或工程开发')), false);
  });

  it('认可真实技术售前、PoC 与交付岗位', () => {
    const score = scoreFor(job({
      title: '大模型AI解决方案顾问',
      salary: '18K-30K',
      tags: ['售前', 'PoC', '大模型'],
      jd_fulltext: `面向企业客户开展大模型需求调研、业务分析和解决方案设计，围绕 RAG、Agent 与 API 快速搭建 PoC 和 Demo，参与售前演示、投标、客户沟通、项目实施交付与培训，不承担销售业绩指标。负责产品落地，沉淀技术文档。`,
    }));
    assert.equal(score.track, 'ai_solutions');
    assert.equal(score.grade, 'B');
    assert.ok(score.matched_skills.includes('咨询与解决方案'));
    assert.ok(score.matched_skills.includes('AI 应用'));
    assert.equal(score.red_flags.some((flag) => flag.includes('销售指标')), false);
    assert.deepEqual(score.required_gaps, []);
  });

  it('认可 AI 产品经理岗位', () => {
    const score = scoreFor(job({
      title: 'AI产品经理',
      tags: ['AI产品', '大模型'],
      jd_fulltext: `负责大模型产品规划、客户需求调研、PRD、原型设计、用户体验和产品落地，围绕 RAG、Agent、知识库和工作流梳理业务场景，协调研发、售前和交付团队推动上线。`,
    }));
    assert.equal(score.track, 'ai_product');
    assert.equal(score.grade, 'A');
    assert.ok(score.matched_skills.includes('产品能力'));
    assert.ok(score.matched_skills.includes('AI 应用'));
    assert.deepEqual(score.required_gaps, []);
  });

  it('认可 AI 客户成功、培训和上线运营岗位', () => {
    const score = scoreFor(job({
      title: 'AI客户成功经理',
      tags: ['客户成功', '大模型'],
      jd_fulltext: `负责企业客户大模型产品上线运营、培训、客户成功、续费留存和需求反馈，围绕 RAG 知识库、Agent 工作流梳理客户场景，推动跨部门交付和复盘，不承担销售业绩指标。`,
    }));
    assert.equal(score.track, 'ai_customer_success');
    assert.equal(score.grade, 'B');
    assert.ok(score.matched_skills.includes('AI 应用'));
    assert.equal(score.red_flags.some((flag) => flag.includes('销售指标')), false);
  });

  it('销售岗位不再因销售指标本身被自动扣分', () => {
    const score = scoreFor(job({
      title: 'AI产品销售经理',
      jd_fulltext: '负责完成季度销售KPI、拓展客户、获客并维护自带客户资源，销售公司的人工智能产品。',
    }));
    assert.equal(score.track, 'pure_sales');
    assert.equal(score.grade, 'C');
    assert.equal(score.dimensions.risk_penalty, 0);
  });

  it('方案型销售、签单回款和业绩目标最高为 C', () => {
    const score = scoreFor(job({
      title: 'AI方案型销售',
      jd_fulltext: '基于公司AI产品为客户提供解决方案，负责客户开拓、商务谈判、签单回款、成交转化和业绩目标，薪资包含高比例提成。',
    }));
    assert.equal(score.grade, 'C');
    assert.ok(score.red_flags.some((flag) => flag.includes('销售指标')));
  });

  it('算法训练岗位被识别为非目标主线并报告能力差距', () => {
    const score = scoreFor(job({
      title: '深度学习算法工程师',
      jd_fulltext: '负责 PyTorch、CUDA、C++ 模型训练、分布式训练、论文复现与算法研究，需要 Python 和硕士学历。',
    }));
    assert.equal(score.track, 'algorithm_research');
    assert.ok(['C', 'D'].includes(score.grade));
    assert.deepEqual(score.required_gaps, []);
  });

  it('模型训练岗位不再因固定候选人画像被自动降档', () => {
    const score = scoreFor(job({
      title: '大模型应用 / AI训练工程师（LLM）',
      jd_fulltext: '负责 RAG 知识库、模型微调、SFT、LoRA、强化学习、推理部署、推理优化和向量数据库，输出技术方案和 Demo。',
    }));
    assert.equal(score.grade, 'B');
    assert.deepEqual(score.required_gaps, []);
    assert.equal(score.red_flags.some((flag) => flag.includes('模型训练')), false);
  });

  it('4–5 年要求在 8 年 B 端经验画像内不扣分', () => {
    const score = scoreFor(job({ experience: '4-5年' }));
    assert.equal(score.dimensions.threshold_fit, 15);
    assert.notEqual(score.grade, 'D');
  });

  it('实习岗位不会因 Agent 标题被误评为可投 B 级', () => {
    const score = scoreFor(job({
      title: 'AI Agent实习生',
      salary: '500-1000元/天',
      experience: '在校/应届',
      tags: ['实习', 'Python', 'Agent'],
    }));
    assert.equal(score.dimensions.threshold_fit, 5);
    assert.ok(['C', 'D'].includes(score.grade));
    assert.ok(score.insufficient_evidence.includes('非月薪制，未纳入正式岗月薪比较'));
    assert.ok(score.evidence.some((item) => item.text.includes('非月薪制')));
    assert.equal(score.insufficient_evidence.includes('薪资未明确'), false);
  });

  it('括号实习标题最高只到 C 级', () => {
    const score = scoreFor(job({
      title: 'AI产品经理（实习）',
      salary: '18-22K',
      experience: '',
      tags: ['AI产品', '大模型'],
      jd_fulltext: '负责大模型产品规划、需求调研、PRD、原型设计和产品落地，围绕 RAG、Agent、知识库和工作流梳理业务场景，协调研发、售前和交付团队推动上线。',
    }));
    assert.equal(score.dimensions.threshold_fit, 5);
    assert.equal(score.grade, 'C');
    assert.ok(score.evidence.some((item) => item.text.includes('实习、校招或兼职岗位')));
  });

  it('在校/应届经验字段按非正式岗处理', () => {
    const score = scoreFor(job({
      title: 'AI产品经理',
      experience: '在校/应届',
      tags: ['AI产品', '大模型'],
      jd_fulltext: '参与企业级 Agent 平台的产品规划与设计，完成需求分析、PRD 撰写、客户访谈、场景拆解和产品上线，围绕 RAG、知识库和工作流推动产品落地。',
    }));
    assert.equal(score.dimensions.threshold_fit, 5);
    assert.equal(score.grade, 'C');
  });

  it('项目实习经验优先不会误判为实习岗位', () => {
    const score = scoreFor(job({
      title: 'AI产品经理',
      experience: '3-5年',
      tags: ['AI产品', '大模型'],
      jd_fulltext: '负责大模型产品规划、客户需求调研、PRD、原型设计、用户体验和产品落地，围绕 RAG、Agent、知识库和工作流梳理业务场景，协调研发、售前和交付团队推动上线；参与过人工智能项目实习者优先。',
    }));
    assert.equal(score.dimensions.threshold_fit, 15);
    assert.equal(score.evidence.some((item) => item.text.includes('实习或兼职岗位')), false);
  });

  it('猎头发布岗位统一归为 C 级', () => {
    const strong = scoreFor(job({
      recruiter_name: '某顾问',
      recruiter_title: '高级猎头顾问',
      is_headhunter: true,
    }));
    const weak = scoreFor(job({
      title: 'AI产品销售经理',
      recruiter_title: '寻访顾问',
      jd_fulltext: '负责销售KPI、客户获客和业绩指标，需要自带客户资源。',
    }));
    assert.equal(strong.grade, 'C');
    assert.equal(weak.grade, 'C');
    assert.match(strong.summary, /猎头发布/);
    assert.ok(strong.evidence.some((item) => item.text.includes('统一归为 C 级')));
  });

  it('明确低于 15K 时等级最高为 C', () => {
    const score = scoreFor(job({ salary: '10-14K' }));
    assert.equal(score.grade, 'C');
    assert.equal(score.dimensions.condition_fit, 5);
  });

  it('未知薪资不推断匹配分并标记信息不足', () => {
    const score = scoreFor(job({ salary: '面议' }));
    assert.ok(score.insufficient_evidence.includes('薪资未明确'));
    assert.equal(score.dimensions.condition_fit, 5);
  });

  it('未上传简历时能力不加分并提示上传后重新匹配', () => {
    const score = scoreWithRules(job(), null, TEST_PROFILE, null, null);
    assert.equal(score.dimensions.capability_fit, 0);
    assert.deepEqual(score.matched_skills, []);
    assert.deepEqual(score.required_gaps, []);
    assert.ok(score.insufficient_evidence.includes('需上传简历后进行能力匹配'));
    assert.match(score.summary, /未上传简历，能力未评分/);
  });

  it('本地能力词典归纳能力类别，同时不把仅 JD 出现的具体技术当作已掌握', () => {
    const resume = '本科。拥有 Java、Spring Boot 和 MySQL 项目经验，负责订单系统开发与性能优化。'.repeat(3);
    const score = scoreWithRules(job({
      title: 'Java开发工程师',
      tags: ['Java', 'Spring Boot', 'Redis'],
      jd_fulltext: '负责 Java、Spring Boot、Redis 服务开发和性能优化。',
    }), null, { ...TEST_PROFILE, targetTracks: ['engineering'] }, null, resume);
    assert.ok(score.dimensions.capability_fit > 0);
    assert.ok(score.matched_skills.includes('软件研发'));
    assert.ok(score.matched_skills.includes('编程语言'));
    assert.ok(score.matched_skills.includes('后端与基础设施'));
    assert.equal(score.matched_skills.some((skill) => /redis/i.test(skill)), false);
    assert.ok(score.evidence.some((item) => item.category === 'capability' && /简历命中.*Spring Boot.*JD 命中.*Spring Boot/.test(item.text)));
    assert.deepEqual(score.required_gaps, []);
  });

  it('本地词典把需求管理和需求分析归纳为产品能力，并保留双方证据', () => {
    const resume = '本科。负责用户访谈、需求管理和产品迭代，推动业务团队与研发协作。'.repeat(3);
    const score = scoreWithRules(job({
      title: '产品经理',
      tags: ['需求分析', 'PRD'],
      jd_fulltext: '负责需求分析、PRD 撰写和产品规划，协同研发推动产品落地。',
    }), null, { ...TEST_PROFILE, targetTracks: ['product'] }, null, resume);
    assert.ok(score.dimensions.capability_fit > 0);
    assert.ok(score.matched_skills.includes('产品能力'));
    assert.ok(score.evidence.some((item) => item.category === 'capability'
      && /产品能力：简历命中.*需求管理.*JD 命中.*需求分析/.test(item.text)));
    assert.deepEqual(score.required_gaps, []);
  });

  it('未配置作息偏好时大小周只提示不扣分', () => {
    const cleanJob = job({
      title: '大模型AI解决方案顾问',
      tags: ['售前', 'PoC', '大模型'],
      jd_fulltext: '面向企业客户开展大模型需求调研、解决方案设计、PoC 演示、客户沟通、项目交付和培训，不承担销售业绩指标。',
    });
    const clean = scoreFor(cleanJob);
    const risky = scoreFor(job({ ...cleanJob, jd_fulltext: `${cleanJob.jd_fulltext} 工作时间为大小周。` }));
    assert.equal(risky.job_match_score, clean.job_match_score);
    assert.equal(risky.total, clean.total);
    assert.equal(risky.dimensions.risk_penalty, 0);
    assert.ok(risky.red_flags.some((flag) => flag.includes('仅提示')));
  });

  it('未配置公司偏好时公司画像保持中性分并保留事实信号', () => {
    const good = scoreFor(job(), company({
      quality_score: 90,
      company_type: 'foreign',
      work_life: 'weekends',
      green_flags: ['外企', '双休'],
      reputation_summary: '外企且双休',
    }));
    const bad = scoreFor(job(), company({
      quality_score: 35,
      company_type: 'outsourcing',
      work_life: 'big_small_week',
      red_flags: ['外包、派遣或驻场', '大小周'],
      reputation_summary: '外包且大小周',
    }));
    assert.equal(good.company_quality_score, 70);
    assert.equal(bad.company_quality_score, 70);
    assert.equal(good.total, bad.total);
    assert.ok(bad.red_flags.includes('大小周'));
    assert.ok(bad.evidence.some((item) => item.category === 'company' && item.text.includes('外包且大小周')));
  });

  it('非 AI 咨询岗位不因固化 AI 偏好被降档', () => {
    const score = scoreFor(job({
      title: 'CRM解决方案顾问',
      tags: ['CRM', '解决方案', '数字化'],
      salary: '25-35K',
      jd_fulltext: '负责CRM及营销数字化项目的客户业务需求调研、销售流程梳理、蓝图设计、方案汇报、系统配置规划、数据迁移协调、用户培训、上线支持和项目验收。需要理解制造业销售管理、客户分层、商机管理、订单协同和经营看板，能够推动跨部门沟通并沉淀实施方法论。',
    }), company({
      quality_score: 95,
      company_type: 'foreign',
      work_life: 'weekends',
      green_flags: ['外企', '双休'],
      reputation_summary: '外企双休成熟公司',
    }));
    assert.equal(score.total >= 65, true);
    assert.equal(score.track, 'consulting');
    assert.equal(score.grade, 'B');
    assert.equal(score.summary.includes('JD 缺少明确 AI 证据'), false);
    assert.equal(score.evidence.some((item) => item.text.includes('最高按 C 级处理')), false);
  });

  it('不会把 JD 未提到的个人技能列为缺失', () => {
    const score = scoreFor(job({
      title: 'AI解决方案顾问',
      tags: ['售前', '大模型'],
      jd_fulltext: '负责 RAG 与 Agent 方案演示、客户沟通、需求调研和培训。',
    }));
    assert.deepEqual(score.required_gaps, []);
    assert.equal(score.required_gaps.includes('TypeScript/JavaScript 工程开发'), false);
  });
});

describe('薪资解析', () => {
  it('支持常见 K、万/月、万/年与多薪格式', () => {
    assert.deepEqual(parseSalary('20K-40K'), { minK: 20, maxK: 40, months: undefined });
    assert.deepEqual(parseSalary('15-30K·14薪'), { minK: 15, maxK: 30, months: 14 });
    assert.deepEqual(parseSalary('1.5-2.5万/月'), { minK: 15, maxK: 25 });
    assert.deepEqual(parseSalary('24-36万/年'), { minK: 20, maxK: 30, months: 12 });
  });
});
