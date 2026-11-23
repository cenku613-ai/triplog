/**
 * 繁體中文檢查（無相依）。
 *
 * 這個專案的 UI 文案與註解一律用繁體，但寫檔時很容易滑進形近的簡體字
 * （「時間」「連不到」「發生」）。這裡放一份「只在簡體出現」的字形對照表，
 * 掃到就列出行號並回非零 exit code。
 *
 * 表不追求完整，只收實際上會打錯的字。繁簡同形、或傳統書寫也接受的寫法
 * （並、內、係、站、台、雲、干、于、周、里、点以外的模糊字）一律不收，避免誤報。
 *
 * 用法：node tools/check-zh.mjs [路徑...]   （不給路徑就掃 src/ mcp/ server/ deploy/ README.md）
 */
const SIMPLIFIED_ONLY = new Map(
  Object.entries({
    // 虛詞／代詞／介詞
    个: '個', 们: '們', 这: '這', 为: '為', 时: '時', 间: '間', 后: '後', 来: '來',
    对: '對', 从: '從', 让: '讓', 给: '給', 会: '會', 与: '與', 么: '麼', 吗: '嗎',
    还: '還', 没: '沒', 几: '幾', 将: '將',
    // 動詞
    写: '寫', 读: '讀', 发: '發', 变: '變', 觉: '覺', 说: '說', 话: '話', 语: '語',
    词: '詞', 请: '請', 谢: '謝', 问: '問', 关: '關', 闭: '閉', 进: '進', 连: '連',
    应: '應', 该: '該', 备: '備', 释: '釋', 档: '檔', 证: '證', 据: '據', 验: '驗',
    试: '試', 测: '測', 览: '覽', 计: '計', 总: '總', 结: '結', 汇: '匯', 预: '預',
    图: '圖', 创: '創', 调: '調', 处: '處', 执: '執', 运: '運', 转: '轉', 换: '換',
    选: '選', 择: '擇', 决: '決', 确: '確', 离: '離', 续: '續', 断: '斷', 编: '編',
    压: '壓', 缩: '縮', 删: '刪', 储: '儲', 实: '實', 际: '際', 属: '屬', 产: '產',
    构: '構', 显: '顯', 设: '設', 摄: '攝', 挂: '掛', 扫: '掃',
    // 名詞／形容詞
    页: '頁', 区: '區', 块: '塊', 单: '單', 员: '員', 组: '組', 织: '織', 团: '團', 范: '範',
    体: '體', 统: '統', 义: '義', 务: '務', 级: '級', 类: '類', 号: '號', 码: '碼',
    标: '標', 签: '簽', 认: '認', 识: '識', 记: '記', 忆: '憶', 网: '網', 门: '門',
    无: '無', 环: '環', 节: '節', 线: '線', 质: '質', 样: '樣', 头: '頭', 层: '層',
    异: '異', 桥: '橋', 检: '檢', 楼: '樓', 欢: '歡', 残: '殘', 毕: '畢', 汉: '漢',
    沟: '溝', 温: '溫', 满: '滿', 灵: '靈', 灾: '災', 炉: '爐', 热: '熱', 爱: '愛',
    状: '狀', 独: '獨', 电: '電', 画: '畫', 疗: '療', 盖: '蓋', 盘: '盤', 协: '協',
    卖: '賣', 双: '雙', 叠: '疊', 听: '聽', 启: '啟', 园: '園', 岁: '歲', 岛: '島',
    币: '幣', 师: '師', 带: '帶', 厅: '廳', 历: '歷', 厨: '廚', 审: '審', 宪: '憲',
    导: '導', 尽: '盡', 监: '監', 县: '縣', 简: '簡', 气: '氣', 灭: '滅', 灯: '燈',
    丽: '麗', 举: '舉', 乐: '樂', 习: '習', 乡: '鄉', 书: '書', 买: '買', 乱: '亂',
    亚: '亞', 亲: '親', 亿: '億', 仅: '僅', 众: '眾', 伤: '傷', 债: '債', 儿: '兒',
    兰: '蘭', 兴: '興', 养: '養', 册: '冊', 况: '況', 净: '淨', 准: '準', 减: '減',
    刘: '劉', 则: '則', 动: '動', 势: '勢', 坚: '堅', 墙: '牆', 声: '聲', 壶: '壺',
    够: '夠', 夹: '夾', 夺: '奪', 娱: '娛', 婴: '嬰', 孙: '孫', 学: '學', 宝: '寶',
    宠: '寵', 宫: '宮', 尘: '塵', 届: '屆', 屿: '嶼', 岗: '崗', 岭: '嶺', 峡: '峽',
    帅: '帥', 帘: '簾', 帮: '幫', 库: '庫', 彻: '徹', 径: '徑', 忧: '憂', 怀: '懷',
    态: '態', 怜: '憐', 悦: '悅', 悬: '懸', 惊: '驚', 惧: '懼', 惨: '慘', 惩: '懲',
    惯: '慣', 愤: '憤', 愿: '願', 懒: '懶', 戏: '戲', 战: '戰', 护: '護', 报: '報',
    担: '擔', 拟: '擬', 拥: '擁', 拦: '攔', 拧: '擰', 掷: '擲', 扬: '揚', 抚: '撫',
    抛: '拋', 扰: '擾', 频: '頻', 载: '載', 辑: '輯', 输: '輸', 辖: '轄', 辈: '輩',
    视: '視', 触: '觸', 规: '規', 觅: '覓', 讨: '討', 训: '訓', 议: '議', 讯: '訊',
    讲: '講', 许: '許', 论: '論', 访: '訪', 评: '評', 诉: '訴', 译: '譯', 诗: '詩',
    诚: '誠', 误: '誤', 课: '課', 谁: '誰', 谈: '談', 谊: '誼', 谱: '譜', 贝: '貝',
    负: '負', 贡: '貢', 财: '財', 责: '責', 贤: '賢', 败: '敗', 货: '貨', 贩: '販',
    贪: '貪', 贫: '貧', 购: '購', 贯: '貫', 贱: '賤', 贵: '貴', 贸: '貿', 费: '費',
    资: '資', 赌: '賭', 赔: '賠', 赚: '賺', 赛: '賽', 赞: '贊', 车: '車', 轨: '軌',
    轻: '輕', 较: '較', 针: '針', 钟: '鐘', 铁: '鐵', 银: '銀', 红: '紅', 绿: '綠',
    蓝: '藍', 黄: '黃', 机: '機', 权: '權', 条: '條', 极: '極', 枪: '槍', 柜: '櫃',
    栏: '欄', 树: '樹', 锅: '鍋', 锐: '銳', 锦: '錦', 键: '鍵', 长: '長', 阅: '閱',
    难: '難', 询: '詢', 详: '詳', 适: '適', 递: '遞', 渔: '漁', 晓: '曉', 术: '術',
    杀: '殺', 杂: '雜', 劝: '勸', 恶: '惡', 恼: '惱', 脏: '髒', 芦: '蘆', 着: '著',
    // 常用但一時容易打錯的
    点: '點', 别: '別', 远: '遠', 观: '觀', 东: '東', 风: '風', 马: '馬', 鸟: '鳥', 鱼: '魚', 龙: '龍',
    数: '數', 万: '萬', 逻: '邏', 辑: '輯', 过: '過', 开: '開', 边: '邊', 击: '擊',
  }),
);

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|css|html|md|yml|yaml|json|sh|conf)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dev-dist', '.git', '.tmp', 'coverage', '.qoder']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.lock', '.map']);

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (!BINARY_EXT.has(name.slice(name.lastIndexOf('.')).toLowerCase())) out.push(p);
  }
  return out;
}

const roots = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const FIX = process.argv.includes('--fix');
const DEFAULT_TARGETS = [
  'src',
  'mcp',
  'server',
  'deploy',
  'scripts',
  'README.md',
  'vite.config.ts',
  'vite.mcp.config.ts',
  'package.json',
  '.env.example',
];
const files = (roots.length ? roots : DEFAULT_TARGETS)
  .flatMap((r) => {
    try {
      return statSync(r).isDirectory() ? walk(r, []) : [r];
    } catch {
      return [];
    }
  })
  .filter((f) => TEXT_EXT.test(f))
  // 本檔整天列著簡體字，掃它只會掃到自己
  .filter((f) => !f.replaceAll('\\', '/').endsWith('tools/check-zh.mjs'));

let hits = 0;
const touched = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    // 專有名詞（例如京都「四条」）可以在該行註明放行：/* zh-allow */
    if (line.includes('zh-allow')) return;
    const bad = [...new Set([...line].flatMap((c) => (SIMPLIFIED_ONLY.has(c) ? [`${c}→${SIMPLIFIED_ONLY.get(c)}`] : [])))];
    if (!bad.length) return;
    hits += 1;
    console.log(`${relative(process.cwd(), file)}:${i + 1}  ${bad.join(' ')}  |  ${line.trim().slice(0, 78)}`);
  });
  const fixed = lines.map((line) =>
    line.includes('zh-allow') ? line : [...line].map((c) => SIMPLIFIED_ONLY.get(c) ?? c).join(''),
  );
  if (FIX && fixed.some((l, i) => l !== lines[i])) {
    touched.push(file);
    writeFileSync(file, fixed.join('\n'));
  }
}

if (FIX && hits) {
  console.log(`\n已取代 ${touched.length} 個檔案、${hits} 行。請用 git diff 再核一次（專有名詞可能要手動回滾）。`);
  process.exit(0);
}

if (hits) {
  console.log(`\n✗ ${hits} 行含簡體字（掃了 ${files.length} 個檔案）`);
  process.exit(1);
}
console.log(`✓ 繁體檢查通過（${files.length} 個檔案、${SIMPLIFIED_ONLY.size} 個對照字）`);
