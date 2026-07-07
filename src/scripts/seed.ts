import { scoreJobs } from '../scorer/index.js';
import { getStore } from '../server/store.js';
import type { RawJob } from '../types.js';

const jobs: RawJob[] = [
  {
    title: 'AI产品经理', company: '湾区智能科技', salary: '20-35K·14薪', location: '深圳·南山',
    source: 'boss', url: 'mock://boss/ai-product-manager', experience: '1-3年', education: '本科',
    tags: ['AI产品', 'RAG', 'Agent'],
    jd_fulltext: '负责 AI 产品规划、客户需求调研、PRD、原型设计、业务场景梳理和产品落地，围绕 Agent、RAG、知识库和工作流协调研发、售前与交付团队推动上线。',
  },
  {
    title: '大模型解决方案顾问', company: '云智方案', salary: '18-30K', location: '深圳',
    source: 'boss', url: 'mock://boss/solution-consultant', experience: '3-5年', education: '本科',
    tags: ['售前', 'PoC', '大模型'],
    jd_fulltext: '面向企业客户进行需求调研、AI解决方案设计和售前演示，使用 RAG、Agent 和 API 搭建 PoC，负责投标、技术文档、培训及交付，不承担销售业绩。',
  },
  {
    title: '金融AI解决方案顾问', company: '前海金融科技', salary: '22-38K', location: '深圳·前海',
    source: 'boss', url: 'mock://boss/fintech-ai', experience: '3-5年', education: '本科',
    tags: ['金融', '售前', 'Agent'],
    jd_fulltext: '面向证券投研和交易场景梳理大模型 Agent、RAG 知识库与自动化工作流方案，负责需求调研、方案演示、产品落地和业务部门沟通。',
  },
  {
    title: '深度学习算法工程师', company: '模型实验室', salary: '25-45K', location: '深圳',
    source: 'boss', url: 'mock://boss/algo', experience: '3-5年', education: '硕士及以上',
    tags: ['PyTorch', 'CUDA'],
    jd_fulltext: '负责 PyTorch、CUDA、C++ 模型训练、分布式训练、模型压缩与论文复现，要求扎实算法研究背景。',
  },
  {
    title: 'AI产品销售经理', company: '增长科技', salary: '15-40K', location: '广州',
    source: 'boss', url: 'mock://boss/sales', experience: '1-3年', education: '本科',
    tags: ['销售'],
    jd_fulltext: '负责 AI 产品销售KPI、客户获客和业绩指标，需要自带客户资源。',
  },
  {
    title: 'AI全栈工程师', company: '早期创业团队', salary: '10-14K', location: '珠海',
    source: 'boss', url: 'mock://boss/kitchen-sink', experience: '1-3年', education: '本科',
    tags: ['AI'],
    jd_fulltext: '负责前端、后端、运维、测试、产品、运营、设计和销售支持，能承受较强工作压力。',
  },
];

async function main(): Promise<void> {
  const scored = await scoreJobs(jobs, { useLlm: false });
  const saved = getStore().upsertJobs(scored);
  console.log(`[mock] 已写入 ${saved} 条示例岗位`);
}

main().catch((error) => {
  console.error(`[mock] ${(error as Error).message}`);
  process.exitCode = 1;
});
