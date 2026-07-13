export interface CapabilityGroup {
  label: string;
  keywords: readonly string[];
  points: number;
}

/**
 * 本地无 API 模式使用的通用能力词典。
 * 只有简历和 JD 都命中同一组时才确认该能力类别，具体命中词会作为证据展示。
 */
export const CAPABILITY_GROUPS: readonly CapabilityGroup[] = [
  { label: '产品能力', points: 4, keywords: ['产品经理', '产品规划', '产品设计', '产品迭代', '需求分析', '需求管理', 'PRD', '产品需求文档', '原型', 'Axure', '用户研究', '用户访谈', '竞品分析', '用户体验', '路线图', '产品落地'] },
  { label: '项目管理', points: 4, keywords: ['项目管理', '项目经理', '进度管理', '风险管理', '资源协调', '里程碑', '项目交付', '验收', '复盘', '敏捷', 'Scrum', '看板', '跨部门协作'] },
  { label: '运营能力', points: 4, keywords: ['产品运营', '用户运营', '内容运营', '活动运营', '社区运营', '商家运营', '增长运营', '策略运营', '运营分析', '用户增长', '留存', '转化', '拉新', '促活'] },
  { label: '市场与品牌', points: 4, keywords: ['市场营销', '品牌营销', '品牌策划', '市场调研', '营销策划', '整合营销', '广告投放', '媒介', '公关', '传播', 'SEO', 'SEM', '信息流投放'] },
  { label: '销售与商务', points: 4, keywords: ['销售', '客户开发', '客户拓展', '商务拓展', 'BD', '渠道拓展', '商机管理', '销售漏斗', '商务谈判', '签约', '回款', '大客户', 'KA', 'CRM'] },
  { label: '客户成功与服务', points: 4, keywords: ['客户成功', '客户服务', '客户运营', '客户培训', '售后支持', '续费', '留存', '客户满意度', '客诉处理', '上线支持', '服务交付'] },
  { label: '咨询与解决方案', points: 4, keywords: ['咨询', '解决方案', '需求调研', '业务分析', '方案设计', '方案汇报', '蓝图设计', '售前', '技术售前', 'PoC', '概念验证', 'Demo', '投标', '实施', '交付'] },
  { label: '数据分析', points: 4, keywords: ['数据分析', '业务分析', '经营分析', '用户分析', '指标体系', '数据看板', '可视化', 'SQL', 'Excel', 'Power BI', 'Tableau', '统计分析', 'A/B 测试'] },
  { label: '软件研发', points: 4, keywords: ['软件开发', '系统开发', '后端', '前端', '全栈', '客户端', '架构设计', '接口开发', 'API', '微服务', '代码评审', '单元测试', '性能优化', '故障排查'] },
  { label: '编程语言', points: 3, keywords: ['Java', 'Python', 'JavaScript', 'TypeScript', 'Go', 'Golang', 'C', 'C++', 'C#', 'PHP', 'Rust', 'Kotlin', 'Swift', 'SQL', 'Shell'] },
  { label: '前端技术', points: 3, keywords: ['HTML', 'CSS', 'Vue', 'React', 'Angular', 'Next.js', 'Webpack', 'Vite', '小程序', '响应式设计', '组件化'] },
  { label: '后端与基础设施', points: 3, keywords: ['Spring', 'Spring Boot', 'Node.js', 'Django', 'Flask', 'FastAPI', 'MySQL', 'PostgreSQL', 'Redis', 'Kafka', 'Docker', 'Kubernetes', 'Linux', 'Nginx', '云服务'] },
  { label: '测试与质量', points: 4, keywords: ['软件测试', '功能测试', '接口测试', '自动化测试', '性能测试', '安全测试', '测试用例', '缺陷管理', '质量保障', 'QA', 'Selenium', 'Playwright'] },
  { label: '数据工程与算法', points: 4, keywords: ['数据仓库', '数据建模', 'ETL', '机器学习', '深度学习', '推荐系统', '自然语言处理', 'NLP', '计算机视觉', '模型训练', '模型部署', 'PyTorch', 'TensorFlow'] },
  { label: 'AI 应用', points: 4, keywords: ['人工智能', 'AI', '大模型', 'LLM', 'AIGC', 'Agent', '智能体', 'RAG', '知识库', 'Prompt', '提示词', '工作流', 'Dify', 'Coze', '扣子', '向量数据库'] },
  { label: '设计能力', points: 4, keywords: ['UI', 'UX', '交互设计', '视觉设计', '平面设计', '品牌设计', '工业设计', '用户体验', 'Figma', 'Sketch', 'Photoshop', 'Illustrator'] },
  { label: '财务与金融', points: 4, keywords: ['财务分析', '会计', '预算', '成本控制', '税务', '审计', '资金管理', '财务报表', '估值', '投研', '风险控制', '证券', '基金', 'FinTech'] },
  { label: '人力资源', points: 4, keywords: ['招聘', '人才招聘', '员工关系', '绩效管理', '薪酬福利', '人才发展', '培训', '组织发展', 'HRBP', '人力资源规划'] },
  { label: '行政与供应链', points: 4, keywords: ['行政管理', '采购', '供应商管理', '供应链', '物流', '仓储', '库存管理', '生产计划', '质量管理', '合同管理', '流程优化'] },
  { label: '通用协作能力', points: 3, keywords: ['沟通协调', '跨部门协作', '团队管理', '团队协作', '问题解决', '逻辑分析', '结构化思维', '文档撰写', '汇报', '演示', '英语', '项目推进'] },
];
