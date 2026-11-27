/**
 * X3-01/X3-02 provider 选路的纯函数层。
 *
 * 这一块以前内联在 `libreChatService.buildProviderTryList()` 里,直接吃 `Math.random`,
 * 于是「排掉某个 provider 之后走谁」「只要 2 票时先看谁」这类问题根本无法断言。
 * 抽出来之后有两件事必须钉住:
 *  1. **随机是可注入的,且不改动入参** —— 原地打乱会让「同一输入第二次跑出不同顺序」这种污染极难定位;
 *  2. **providerKey 永不含凭据** —— 这个值会进诊断对象、评测报告、也许还有管理端界面,
 *     凭据一旦进来就再也洗不干净。
 */

import {
  buildTryList,
  expandByWeight,
  hasCapableProvider,
  providerKey,
  shuffleWithRandom,
  type ProviderCandidate,
  type ProviderRequirement,
} from "../services/librechat/selection";

const A: ProviderCandidate = { baseUrl: "https://a.example.com/v1", apiKey: "sk-a-very-secret", model: "mA" };
const B: ProviderCandidate = { baseUrl: "https://b.example.com/v1", apiKey: "sk-b-very-secret", model: "mB", weight: 3 };
const V: ProviderCandidate = { baseUrl: "https://v.example.com/v1", apiKey: "sk-v-very-secret", model: "mVision", vision: true };
const DISABLED: ProviderCandidate = { baseUrl: "https://d.example.com/v1", apiKey: "sk-d", model: "mD", enabled: false };

/** 固定序列的注入随机:每次调用给一个预设值,耗尽后重复最后一个,保证用例可复现。 */
function seededRolls(rolls: number[]): () => number {
  let index = 0;
  return () => {
    const value = rolls[index];
    if (index < rolls.length - 1) index += 1;
    return value;
  };
}

function modelsOf(list: { model: string }[]): string[] {
  return list.map((provider) => provider.model);
}

describe("providerKey(X3-02)", () => {
  it("取 URL 的 host,丢掉协议与路径", () => {
    expect(providerKey({ baseUrl: "https://a.example.com/v1", model: "mA" })).toBe("mA@a.example.com");
    expect(providerKey({ baseUrl: "https://a.example.com/", model: "mA" })).toBe("mA@a.example.com");
  });

  it("同 host 同 model 不同路径得到同一个 key(exclude 才能命中)", () => {
    expect(providerKey({ baseUrl: "https://a.example.com/v1", model: "mA" })).toBe(providerKey({ baseUrl: "https://a.example.com/v1beta/chat", model: "mA" }));
  });

  it("端口参与区分:本机不同代理不能撞同一个 key", () => {
    expect(providerKey({ baseUrl: "http://127.0.0.1:3000/v1", model: "mA" })).toBe("mA@127.0.0.1:3000");
    expect(providerKey({ baseUrl: "http://127.0.0.1:4000/v1", model: "mA" })).toBe("mA@127.0.0.1:4000");
  });

  it("非 URL 形态的 baseUrl(裸 host)走字符串兜底,不抛错", () => {
    expect(providerKey({ baseUrl: "api.example.com/v1", model: "mA" })).toBe("mA@api.example.com");
    expect(providerKey({ baseUrl: "", model: "" })).toBe("@");
  });

  it("model 参与区分:同 host 换模型不是同一个 provider", () => {
    expect(providerKey({ baseUrl: "https://a.example.com/v1", model: "m1" })).not.toBe(providerKey({ baseUrl: "https://a.example.com/v1", model: "m2" }));
  });

  it("绝不含 apiKey(候选对象带凭据也一样)", () => {
    for (const candidate of [A, B, V]) {
      const key = providerKey(candidate);
      // 先确认 fixture 真的带了凭据,否则下面那几条「不含凭据」就是空断言。
      expect(candidate.apiKey?.length ?? 0).toBeGreaterThan(6);
      expect(key).not.toContain(String(candidate.apiKey));
      expect(key).not.toContain("secret");
      expect(key).not.toContain("sk-");
    }
  });
});

describe("shuffleWithRandom(X3-01)", () => {
  const source = ["a", "b", "c", "d", "e"];

  it("同种子 → 同顺序", () => {
    const first = shuffleWithRandom(source, seededRolls([0.9, 0.1, 0.5, 0.2]));
    const second = shuffleWithRandom(source, seededRolls([0.9, 0.1, 0.5, 0.2]));
    expect(first).toEqual(second);
    expect(first).not.toEqual(source);
  });

  it("不改动入参(纯函数被反复调用时不能被自己的副作用污染)", () => {
    const snapshot = [...source];
    shuffleWithRandom(source, seededRolls([0.4, 0.4, 0.4, 0.4]));
    expect(source).toEqual(snapshot);
    expect(shuffleWithRandom(source, () => 0.5)).not.toBe(source);
  });

  it("不丢不重:洗牌结果始终是同一批元素", () => {
    const shuffled = shuffleWithRandom(source, seededRolls([0.77, 0.31, 0.02, 0.95]));
    expect([...shuffled].sort()).toEqual([...source].sort());
    expect(shuffled).toHaveLength(source.length);
  });

  it("随机源退化时(默认 Math.random)也只是顺序不同,不会越界", () => {
    const shuffled = shuffleWithRandom(source);
    expect([...shuffled].sort()).toEqual([...source].sort());
  });

  it("非法 roll(NaN/负数)按 0 处理:整串左旋一位,而不是产出 undefined 洞", () => {
    const expected = ["b", "c", "d", "e", "a"];
    expect(shuffleWithRandom(source, () => Number.NaN)).toEqual(expected);
    expect(shuffleWithRandom(source, () => -1)).toEqual(expected);
  });

  it("roll 大于 1 被夹在上界内:等价于原地不动,不会写到数组外面", () => {
    expect(shuffleWithRandom(source, () => 1.9)).toEqual(source);
  });

  it("空数组与单元素数组直接返回同一批内容(洗牌不会凭空造出洞)", () => {
    expect(shuffleWithRandom([], () => 0.5)).toEqual([]);
    expect(shuffleWithRandom(["only"], () => 0.5)).toEqual(["only"]);
  });
});

describe("expandByWeight(X3-01)", () => {
  it("按 weight 展开成抽签池,且保持原对象引用", () => {
    const expanded = expandByWeight([A, B]);
    expect(expanded).toHaveLength(4);
    expect(modelsOf(expanded)).toEqual(["mA", "mB", "mB", "mB"]);
    expect(expanded[0]).toBe(A);
  });

  it("weight 收敛到 [1,10]:0/负数/非有限值都按 1,超大按 10", () => {
    const clamp = (weight: number | undefined): number =>
      expandByWeight([{ baseUrl: "https://a.example.com/v1", model: "mA", weight }]).length;
    expect(clamp(0)).toBe(1);
    expect(clamp(-5)).toBe(1);
    expect(clamp(Number.NaN)).toBe(1);
    expect(clamp(undefined)).toBe(1);
    expect(clamp(2.7)).toBe(2);
    expect(clamp(99)).toBe(10);
    expect(clamp(10)).toBe(10);
  });

  it("enabled=false 被过滤;缺 baseUrl 或 model 的脏数据也被过滤", () => {
    expect(modelsOf(expandByWeight([A, DISABLED]))).toEqual(["mA"]);
    expect(expandByWeight([{ baseUrl: "", model: "mX" }])).toEqual([]);
    expect(expandByWeight([{ baseUrl: "https://a.example.com", model: "" }])).toEqual([]);
  });

  it("requireVision 只放行 vision 为 true 的候选(X1-06 的判定基础)", () => {
    const requirement: ProviderRequirement = { requireVision: true };
    expect(modelsOf(expandByWeight([A, V, DISABLED], requirement))).toEqual(["mVision"]);
    // 未要求识图时,识图候选也在池里(不能因为会识图就被特殊对待)。
    expect(modelsOf(expandByWeight([A, V]))).toEqual(["mA", "mVision"]);
  });

  it("vision 只有严格 true 才算能力位(true 以外的字符串不算)", () => {
    const pool: ProviderCandidate[] = [{ baseUrl: "https://x.example.com", model: "mX", vision: "true" as unknown as boolean }];
    expect(expandByWeight(pool, { requireVision: true })).toEqual([]);
  });

  it("group 过滤:空串/未给 = 不按分组过滤;要求值两端空白被忽略", () => {
    const grouped: ProviderCandidate[] = [
      { baseUrl: "https://a.example.com/v1", model: "mA", group: "g1" },
      { baseUrl: "https://b.example.com/v1", model: "mB", group: "g2" },
      { baseUrl: "https://c.example.com/v1", model: "mC" },
    ];
    expect(modelsOf(expandByWeight(grouped, { group: "g1" }))).toEqual(["mA"]);
    expect(modelsOf(expandByWeight(grouped, { group: "  g2  " }))).toEqual(["mB"]);
    expect(modelsOf(expandByWeight(grouped, { group: "   " }))).toEqual(["mA", "mB", "mC"]);
    expect(modelsOf(expandByWeight(grouped))).toEqual(["mA", "mB", "mC"]);
    expect(modelsOf(expandByWeight(grouped, { group: "nope" }))).toEqual([]);
  });

  it("exclude 按 providerKey 生效(X3-07 的每票排重靠它)", () => {
    expect(modelsOf(expandByWeight([A, B], { exclude: [providerKey(A)] }))).toEqual(["mB", "mB", "mB"]);
    // exclude 里的 key 要按同一套 host 归一规则匹配:带不带路径都算同一个 provider。
    expect(modelsOf(expandByWeight([A, B], { exclude: ["mA@a.example.com"] }))).toEqual(["mB", "mB", "mB"]);
    expect(modelsOf(expandByWeight([A, B], { exclude: [] }))).toEqual(["mA", "mB", "mB", "mB"]);
    expect(modelsOf(expandByWeight([A, B], { exclude: ["unknown@nowhere"] }))).toEqual(["mA", "mB", "mB", "mB"]);
  });

  it("exclude 的匹配口径不含凭据:传 apiKey 进去也排除不掉", () => {
    expect(modelsOf(expandByWeight([A, B], { exclude: ["sk-a-very-secret"] }))).toEqual(["mA", "mB", "mB", "mB"]);
  });

  it("空池 / 缺省 requirement 不抛错", () => {
    expect(expandByWeight([])).toEqual([]);
    expect(expandByWeight([], {})).toEqual([]);
    expect(expandByWeight([DISABLED], { requireVision: true })).toEqual([]);
  });
});

describe("buildTryList(X3-01/X3-07)", () => {
  it("weight 展开后按引用去重:同一个模型不会被连着试三次", () => {
    const list = buildTryList({ pool: [B], random: () => 0.5 });
    expect(list).toHaveLength(1);
    expect(list[0]?.model).toBe("mB");
  });

  it("解析出稳定的 ResolvedProvider:baseUrl 去尾斜杠、wire 归一、缺凭据回退空串", () => {
    const list = buildTryList({
      pool: [{ baseUrl: "https://a.example.com/v1///", model: "mA", wire: "nonsense" }],
      random: () => 0.5,
    });
    expect(list[0]).toEqual({
      baseUrl: "https://a.example.com/v1",
      apiKey: "",
      model: "mA",
      wire: "openai-chat",
      vision: false,
      source: "db",
    });
  });

  it("wire 原样保留三种合法线格式", () => {
    const list = buildTryList({
      pool: [
        { baseUrl: "https://a.example.com", model: "mA", wire: "anthropic" },
        { baseUrl: "https://b.example.com", model: "mB", wire: "openai-responses" },
      ],
      random: () => 0.5,
    });
    expect(list.map((provider) => provider.wire)).toEqual(["anthropic", "openai-responses"]);
  });

  it("同种子 → 同顺序,且两次调用互不影响", () => {
    const pool = [A, B, V];
    const rolls = [0.85, 0.12, 0.5, 0.3, 0.9, 0.05];
    const first = modelsOf(buildTryList({ pool, random: seededRolls(rolls) }));
    const second = modelsOf(buildTryList({ pool, random: seededRolls(rolls) }));
    expect(first).toEqual(second);
    expect([...first].sort()).toEqual(["mA", "mB", "mVision"]);
    // 入参池不能被洗牌改动
    expect(modelsOf(pool)).toEqual(["mA", "mB", "mVision"]);
  });

  it("先洗牌后截断:limit 取到的是随机的一位,而不是池子固定第一个", () => {
    const pool = [A, B, V];
    const headFirst = buildTryList({ pool, requirement: { limit: 1 }, random: () => 0.99 });
    const tailFirst = buildTryList({ pool, requirement: { limit: 1 }, random: () => 0.01 });
    expect(headFirst).toHaveLength(1);
    expect(tailFirst).toHaveLength(1);
    expect(headFirst[0]?.model).toBe("mA");
    expect(tailFirst[0]?.model).toBe("mB");
    expect(headFirst[0]?.model).not.toBe(tailFirst[0]?.model);
  });

  it("limit 非法(0/负数/非数字)时不截断", () => {
    const pool = [A, B, V];
    expect(buildTryList({ pool, requirement: { limit: 0 }, random: () => 0.5 })).toHaveLength(3);
    expect(buildTryList({ pool, requirement: { limit: -3 }, random: () => 0.5 })).toHaveLength(3);
    expect(buildTryList({ pool, requirement: { limit: Number.NaN }, random: () => 0.5 })).toHaveLength(3);
    expect(buildTryList({ pool, requirement: { limit: 99 }, random: () => 0.5 })).toHaveLength(3);
  });

  it("requirement 完整生效:识图要求 + 排除 + 上限可以叠在一起", () => {
    const pool = [A, B, V];
    const list = buildTryList({
      pool,
      requirement: { requireVision: true, exclude: [providerKey(V)], limit: 2 },
      random: () => 0.5,
    });
    expect(list).toEqual([]);
  });

  it("环境变量兜底:baseUrl/apiKey/model 齐了才进候选", () => {
    const complete: ProviderCandidate = { baseUrl: "https://env.example.com/v1", apiKey: "sk-env", model: "mEnv" };
    expect(modelsOf(buildTryList({ pool: [A], envProvider: complete, random: () => 0.5 }))).toEqual(["mA", "mEnv"]);
    // 缺 apiKey 的 env 配置等于没配 —— 否则会把一个必然 401 的候选塞进尝试序列。
    expect(modelsOf(buildTryList({ pool: [A], envProvider: { baseUrl: "https://env.example.com/v1", model: "mEnv" }, random: () => 0.5 }))).toEqual(["mA"]);
    expect(modelsOf(buildTryList({ pool: [A], envProvider: null, random: () => 0.5 }))).toEqual(["mA"]);
  });

  it("envFirst 控制兜底位次(老语义 envFallbackFirst)", () => {
    const env: ProviderCandidate = { baseUrl: "https://env.example.com/v1", apiKey: "sk-env", model: "mEnv" };
    expect(modelsOf(buildTryList({ pool: [A], envProvider: env, envFirst: true, random: () => 0.5 }))).toEqual(["mEnv", "mA"]);
    expect(modelsOf(buildTryList({ pool: [A], envProvider: env, random: () => 0.5 }))).toEqual(["mA", "mEnv"]);
  });

  it("库里与环境变量指向同一个模型时两条都保留(source 不同 = 不同的调用配置)", () => {
    const env: ProviderCandidate = { baseUrl: "https://a.example.com/v1", apiKey: "sk-env", model: "mA" };
    const list = buildTryList({ pool: [A], envProvider: env, random: () => 0.5 });
    expect(list.map((provider) => provider.source)).toEqual(["db", "env"]);
    expect(providerKey(list[0]!)).toBe(providerKey(list[1]!));
    expect(list[0]?.apiKey).toBe("sk-a-very-secret");
    expect(list[1]?.apiKey).toBe("sk-env");
  });

  it("空池且不配 env → 空序列(交给上层判 no_provider_configured)", () => {
    expect(buildTryList({ pool: [], random: () => 0.5 })).toEqual([]);
  });

  it("ResolvedProvider 的 key 也不含凭据", () => {
    const list = buildTryList({ pool: [A], random: () => 0.5 });
    expect(providerKey(list[0]!)).toBe("mA@a.example.com");
  });
});

describe("hasCapableProvider(X1-06 fail-closed 判定)", () => {
  it("池子里有识图候选才允许带图请求", () => {
    expect(hasCapableProvider([A, V], { requireVision: true })).toBe(true);
    expect(hasCapableProvider([A, DISABLED, { baseUrl: "https://x.example.com", model: "mX", vision: false }], { requireVision: true })).toBe(false);
    expect(hasCapableProvider([], { requireVision: true })).toBe(false);
  });

  it("无 requirement 时等价于「有没有可用 provider」", () => {
    expect(hasCapableProvider([DISABLED])).toBe(false);
    expect(hasCapableProvider([A])).toBe(true);
    expect(hasCapableProvider([])).toBe(false);
  });

  it("exclude 掉唯一一个候选后就是没有能力(票源耗尽要显式暴露)", () => {
    expect(hasCapableProvider([A], { exclude: [providerKey(A)] })).toBe(false);
    expect(hasCapableProvider([A, B], { exclude: [providerKey(A)] })).toBe(true);
  });
});
