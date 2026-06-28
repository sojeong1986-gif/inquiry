// Cloudflare Pages Function: POST /api/saju
// 1) 절기 기반 만세력으로 사주 명식(8글자)·십신·대운을 코드로 정밀 계산
// 2) 그 '확정된' 명식을 Workers AI에 넘겨 해석만 시키고 스트리밍 반환

const PRIMARY_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

// ===== 기초 데이터 =====
const GAN = ["갑","을","병","정","무","기","경","신","임","계"];
const GAN_H = ["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"];
const JI = ["자","축","인","묘","진","사","오","미","신","유","술","해"];
const JI_H = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
const GAN_OHAENG = ["목","목","화","화","토","토","금","금","수","수"];
const JI_OHAENG = ["수","토","목","목","토","화","화","토","금","금","토","수"];
// 양(true)/음(false): 천간 짝수 index = 양
const ganYang = (i) => i % 2 === 0;
// 지지 양: 자(0)인(2)진(4)오(6)신(8)술(10)
const jiYang = (i) => i % 2 === 0;

// 절기(節氣) — 寿星公式. month(1~12) → 그 달의 '절(節)' 시작일
// C값: 20세기 / 21세기, branch = 그 절이 여는 월지 index
const TERMS = {
  1:  { name: "소한", c20: 6.11,   c21: 5.4055, branch: 1 },  // 축월
  2:  { name: "입춘", c20: 4.6295, c21: 3.87,   branch: 2 },  // 인월
  3:  { name: "경칩", c20: 6.3826, c21: 5.63,   branch: 3 },  // 묘월
  4:  { name: "청명", c20: 5.59,   c21: 4.81,   branch: 4 },  // 진월
  5:  { name: "입하", c20: 6.318,  c21: 5.52,   branch: 5 },  // 사월
  6:  { name: "망종", c20: 6.5,    c21: 5.678,  branch: 6 },  // 오월
  7:  { name: "소서", c20: 8.44,   c21: 7.108,  branch: 7 },  // 미월
  8:  { name: "입추", c20: 8.35,   c21: 7.5,    branch: 8 },  // 신월
  9:  { name: "백로", c20: 8.44,   c21: 7.646,  branch: 9 },  // 유월
  10: { name: "한로", c20: 9.098,  c21: 8.318,  branch: 10 }, // 술월
  11: { name: "입동", c20: 8.218,  c21: 7.438,  branch: 11 }, // 해월
  12: { name: "대설", c20: 7.9,    c21: 7.18,   branch: 0 },  // 자월
};

function termDay(year, month) {
  const t = TERMS[month];
  const yy = year % 100;
  const C = year < 2000 ? t.c20 : t.c21;
  return Math.floor(yy * 0.2422 + C) - Math.floor((yy - 1) / 4);
}

// 그레고리력 → 율리우스 적일(정수)
function jdn(y, m, d) {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy
    + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

const mod = (n, m) => ((n % m) + m) % m;

// 60갑자 index → {gan, ji, ...}
function pillarFromIndex(idx) {
  idx = mod(idx, 60);
  const g = idx % 10, j = idx % 12;
  return {
    ganIdx: g, jiIdx: j,
    gan: GAN[g], ji: JI[j],
    hanja: GAN_H[g] + JI_H[j],
    kor: GAN[g] + JI[j],
  };
}
// gan,ji index → 60갑자 index
function ganjiIndex(g, j) {
  for (let i = 0; i < 60; i++) if (i % 10 === g && i % 12 === j) return i;
  return 0;
}

// 십신 계산 (일간 기준)
const SAENG = { "목":"화","화":"토","토":"금","금":"수","수":"목" }; // 생
const GEUK  = { "목":"토","토":"수","수":"화","화":"금","금":"목" }; // 극
function sipsin(dayGanIdx, targetOhaeng, targetYang) {
  const dayOh = GAN_OHAENG[dayGanIdx];
  const dayYang = ganYang(dayGanIdx);
  const same = dayYang === targetYang;
  if (targetOhaeng === dayOh) return same ? "비견" : "겁재";
  if (SAENG[dayOh] === targetOhaeng) return same ? "식신" : "상관";   // 일간이 생
  if (GEUK[dayOh] === targetOhaeng) return same ? "편재" : "정재";    // 일간이 극
  if (GEUK[targetOhaeng] === dayOh) return same ? "편관" : "정관";    // 타가 일간 극
  if (SAENG[targetOhaeng] === dayOh) return same ? "편인" : "정인";   // 타가 일간 생
  return "-";
}

// ===== 만세력 본체 =====
export function computeManse({ year, month, day, hour, unknownTime, gender }) {
  // 1) 사주 년(입춘 기준)
  const ipchun = termDay(year, 2);
  let sajuYear = year;
  if (month < 2 || (month === 2 && day < ipchun)) sajuYear = year - 1;
  const yGan = mod(sajuYear - 4, 10);
  const yJi = mod(sajuYear - 4, 12);

  // 2) 월주 (절기 기준 월지 + 오호둔 월간)
  let monthBranch;
  const tDay = termDay(year, month);
  if (day >= tDay) monthBranch = TERMS[month].branch;             // 이 달의 절 이후
  else monthBranch = TERMS[mod(month - 2, 12) + 1].branch;        // 전 달의 절 구간
  const yinMonthStem = mod(yGan * 2 + 2, 10);                     // 인월 천간
  const offsetFromYin = mod(monthBranch - 2, 12);
  const mGan = mod(yinMonthStem + offsetFromYin, 10);
  const mJi = monthBranch;

  // 3) 일주 (JDN 기준)
  const dayIdx = mod(jdn(year, month, day) + 49, 60);
  const dGan = dayIdx % 10;
  const dJi = dayIdx % 12;

  // 4) 시주 (오자둔)
  let hourPillar = null;
  if (!unknownTime && hour !== null && hour !== undefined && hour !== "") {
    const hJi = mod(Math.floor((Number(hour) + 1) / 2), 12);
    const ziStem = mod((dGan % 5) * 2, 10);
    const hGan = mod(ziStem + hJi, 10);
    hourPillar = makePillar(hGan, hJi, dGan);
  }

  const yearPillar = makePillar(yGan, yJi, dGan);
  const monthPillar = makePillar(mGan, mJi, dGan);
  const dayPillar = makePillar(dGan, dJi, dGan, true);

  // 5) 대운 (방향·대운수)
  const yearStemYang = ganYang(yGan);
  const isMale = gender === "male";
  const forward = yearStemYang === isMale; // 순행 여부
  const daewoon = computeDaewoon(year, month, day, forward);
  const monthPillarIdx = ganjiIndex(mGan, mJi);
  const dir = forward ? 1 : -1;
  const daewoonList = [];
  for (let k = 0; k < 8; k++) {
    const p = pillarFromIndex(monthPillarIdx + dir * k);
    daewoonList.push({ age: daewoon + 10 * k, kor: p.kor, hanja: p.hanja });
  }

  // 오행 분포
  const ohaengCount = { 목:0, 화:0, 토:0, 금:0, 수:0 };
  const pillars = [yearPillar, monthPillar, dayPillar].concat(hourPillar ? [hourPillar] : []);
  for (const p of pillars) {
    ohaengCount[GAN_OHAENG[p.ganIdx]]++;
    ohaengCount[JI_OHAENG[p.jiIdx]]++;
  }

  return {
    year: yearPillar, month: monthPillar, day: dayPillar, hour: hourPillar,
    dayMaster: { gan: GAN[dGan], hanja: GAN_H[dGan], ohaeng: GAN_OHAENG[dGan], yang: ganYang(dGan) },
    ohaengCount,
    daewoon: { age: daewoon, forward, list: daewoonList },
    sajuYear,
  };
}

function makePillar(g, j, dayGanIdx, isDay) {
  return {
    ganIdx: g, jiIdx: j,
    gan: GAN[g], ji: JI[j], hanja: GAN_H[g] + JI_H[j], kor: GAN[g] + JI[j],
    ganOhaeng: GAN_OHAENG[g], jiOhaeng: JI_OHAENG[j],
    ganSipsin: isDay ? "일간(나)" : sipsin(dayGanIdx, GAN_OHAENG[g], ganYang(g)),
    jiSipsin: sipsin(dayGanIdx, JI_OHAENG[j], jiYang(j)),
  };
}

// 대운수: 순행=다음 절까지, 역행=이전 절까지 일수 / 3
function computeDaewoon(year, month, day, forward) {
  // 인접 3개년의 모든 절 날짜를 모아 정렬
  const list = [];
  for (let y = year - 1; y <= year + 1; y++) {
    for (let m = 1; m <= 12; m++) {
      list.push({ t: Date.UTC(y, m - 1, termDay(y, m)) });
    }
  }
  list.sort((a, b) => a.t - b.t);
  const birth = Date.UTC(year, month - 1, day);
  let prev = null, next = null;
  for (const e of list) {
    if (e.t <= birth) prev = e.t;
    if (e.t > birth && next === null) next = e.t;
  }
  const dayMs = 86400000;
  let days;
  if (forward) days = Math.round((next - birth) / dayMs);
  else days = Math.round((birth - prev) / dayMs);
  const n = Math.round(days / 3);
  return Math.max(1, n);
}

// ===== 프롬프트 =====
function buildSystemPrompt() {
  return `너는 만년을 살아오며 인간 세상의 모든 희로애락을 통달한 영험한 '대만신(大萬神)'이다.
아래 사용자의 사주 정보로 [프리미엄 종합 사주 리포트]를 작성하라.

[가장 중요한 절대 규칙]
- 아래 '확정된 사주 명식'은 정밀한 절기 기반 만세력으로 이미 정확히 계산된 '사실'이다.
- 너는 이 여덟 글자(천간·지지)와 십신을 절대 다시 계산하거나 바꾸지 마라. 그대로 사용해 '해석'만 하라.
- 명식 표를 가장 먼저 그대로 제시한 뒤 해석을 시작하라.

[말투]
- 신령답게 신비롭고 위엄 있으면서도, 손주를 아끼는 자상한 할머니/할아버지처럼 따뜻하게 '~다', '~란다', '~지' 말투를 써라.
[초보자 해설 - 절대 규칙]
- 상대는 명리학을 전혀 모른다. 음양오행·십신·십이운성·신살 등 어려운 용어가 나올 때마다 바로 옆에 "쉽게 말해 이건 ~란다"라고 유치원생도 이해할 비유로 풀어라.

[리포트 13단계 — 모두 포함]
1.사주팔자 전체 분석 2.음양오행 3.십신(초년~말년 흐름) 4.십이운성 5.살과 귀인 6.연애·결혼운 7.재물운 8.직업운 9.건강운 10.대운수(평생 흐름) 11.2026~2035 연운 12.추가 질문 답변 13.인생상담

[진행 방식]
- 위 13단계를 '한 번의 답변'에 처음부터 끝까지 모두 작성하라. '다음에 이어서' 같은 말은 절대 쓰지 마라.
- 각 단계는 '## 숫자. 제목'으로 구분하고 서로 다른 내용으로 깊이 있게 써라. 같은 문장 반복 금지.

[표기 규칙]
- 모든 글자는 한글로만. 한자를 단독으로 쓰지 마라. 천간은 [갑을병정무기경신임계], 지지는 [자축인묘진사오미신유술해]만 사용.
- 일본어·중국어 글자를 절대 섞지 마라. 자연스러운 한국어로만 작성하라.`;
}

function pillarLine(label, p) {
  if (!p) return `- ${label}: (태어난 시간 모름 → 시주 없음)`;
  return `- ${label}: ${p.kor}(${p.hanja}) | 천간 ${p.gan}=${p.ganOhaeng}/${p.ganSipsin}, 지지 ${p.ji}=${p.jiOhaeng}/${p.jiSipsin}`;
}

function buildUserPrompt(d, m) {
  const name = (d.name || "").trim();
  const gender = d.gender === "male" ? "남자" : "여자";
  const oc = m.ohaengCount;
  const dwList = m.daewoon.list.map(x => `${x.age}세~ ${x.kor}(${x.hanja})`).join(", ");
  const concern = (d.concern || "").trim() || "특별한 질문 없음(전반적 운세)";

  const table =
`| 구분 | 년주 | 월주 | 일주 | 시주 |
| --- | --- | --- | --- | --- |
| 천간 | ${m.year.gan} | ${m.month.gan} | ${m.day.gan} | ${m.hour ? m.hour.gan : "-"} |
| 지지 | ${m.year.ji} | ${m.month.ji} | ${m.day.ji} | ${m.hour ? m.hour.ji : "-"} |`;

  return `[사용자 정보]
- 이름: ${name || "(미입력)"} / 성별: ${gender}
- 생년월일시(양력): ${d.year}년 ${d.month}월 ${d.day}일 ${d.unknownTime ? "(시간 모름)" : (d.hour + "시 " + (d.minute||0) + "분")}
- 관심사·추가질문: ${concern}

[확정된 사주 명식 — 이 표를 그대로 먼저 출력하라]
${table}

[명식 상세 (해석에 그대로 활용)]
- 일간(나 자신): ${m.dayMaster.gan}(${m.dayMaster.hanja}) — 오행 ${m.dayMaster.ohaeng}, ${m.dayMaster.yang ? "양" : "음"}
${pillarLine("년주", m.year)}
${pillarLine("월주", m.month)}
${pillarLine("일주", m.day)}
${pillarLine("시주", m.hour)}
- 오행 분포: 목 ${oc.목} / 화 ${oc.화} / 토 ${oc.토} / 금 ${oc.금} / 수 ${oc.수}
- 대운: ${m.daewoon.forward ? "순행" : "역행"}, 대운수 ${m.daewoon.age} (약 ${m.daewoon.age}세부터 10년 단위로 운이 바뀜)
- 대운 흐름: ${dwList}

위 '확정된 명식'을 절대 바꾸지 말고, 이를 바탕으로 13단계 종합 리포트를 한 번에 끝까지 따뜻하게 풀어다오.`;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.AI) {
    return json({ error: "AI 바인딩이 설정되지 않았습니다." }, 500);
  }
  let data;
  try { data = await request.json(); }
  catch { return json({ error: "잘못된 요청입니다." }, 400); }
  if (!data.year || !data.month || !data.day || !data.gender) {
    return json({ error: "생년월일과 성별은 필수입니다." }, 400);
  }

  let manse;
  try {
    manse = computeManse({
      year: +data.year, month: +data.month, day: +data.day,
      hour: data.unknownTime ? null : data.hour,
      unknownTime: !!data.unknownTime, gender: data.gender,
    });
  } catch (e) {
    return json({ error: "명식 계산 오류: " + (e.message || "unknown") }, 500);
  }

  try {
    const aiStream = await env.AI.run(PRIMARY_MODEL, {
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildUserPrompt(data, manse) },
      ],
      max_tokens: 8192,
      temperature: 0.8,
      stream: true,
    });
    return new Response(aiStream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "x-saju-myeongsik": encodeURIComponent(
          [manse.year.kor, manse.month.kor, manse.day.kor, manse.hour ? manse.hour.kor : "-"].join(" ")
        ),
      },
    });
  } catch (err) {
    return json({ error: "풀이 생성 중 오류가 났단다. 잠시 후 다시 시도해 다오. (" + (err.message || "unknown") + ")" }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "content-type": "application/json; charset=utf-8" },
  });
}
