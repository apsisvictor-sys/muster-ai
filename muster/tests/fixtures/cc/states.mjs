/**
 * Fixture states for the command center page (WP1b), in the shapes blueprint R5.3 gives the composer.
 *
 * The page renders from `/cc/api/state`; these are that answer, one per state the page must show
 * (R5.1's empty, loading and stale states included, plus the two adversarial ones: injected markup as
 * text, and a gateway restart). The QA run serves them on a local port so the acceptance screenshots
 * never touch the live gateway. `panels.<name>.data === null` with an `error` is the panel-error state;
 * `absent` names a panel this fixture leaves out, which is how the page behaves before WPS merges.
 */

const READ_AT = "2026-10-25T01:30:00.000Z";
const STARTED_AT = "2026-10-24T22:05:00.000Z";

const panel = (data) => ({ readAt: READ_AT, error: null, data });
const failed = (error) => ({ readAt: READ_AT, error, data: null });

const lane = (over) => ({
  laneId: "lane",
  harness: "pi",
  model: "deepseek-v4.1-flash",
  state: "running",
  phase: null,
  origin: "auto",
  alive: true,
  since: Date.parse(READ_AT) - 25 * 60000,
  lastActivityMs: 4 * 60000,
  branch: "lane/example",
  brief: "Build the thing the brief names",
  stalled: false,
  leftover: false,
  canStop: false,
  tone: null,
  reason: null,
  startedAt: "2026-10-25T01:05:00.000Z",
  lastMessage: "Reading the brief, then the owner it names.",
  contextPercent: 24,
  report: null,
  ...over,
});

// The composer's own marks (D16): `sitting` from SITTING_KINDS, `recommended` from the option equal to the recommendation.
const SITTING_KINDS = ["operator-action", "human-login", "credential"];
const ticket = (over) => withMarks({
  id: "ask_fixture",
  code: "VH6",
  kind: "product-decision",
  question: "Which of the two readings do you want?",
  owner: "architect",
  raisedBy: "architect",
  raisedAt: "2026-10-24T22:00:00.000Z",
  ageMs: 3 * 3600000,
  stale: false,
  blocks: [],
  options: ["The first reading", "The second reading"],
  recommendation: "The first reading",
  status: "open",
  answerOnCard: false,
  version: "v1",
  ...over,
});
function withMarks(entry) {
  const options = Array.isArray(entry.options) ? entry.options : [];
  const wanted = typeof entry.recommendation === "string" ? entry.recommendation.trim().toLowerCase() : null;
  const match = wanted === null ? undefined : options.find((option) => option.trim().toLowerCase() === wanted);
  return { sitting: SITTING_KINDS.includes(entry.kind), recommended: match ?? null, ...entry };
}

const ideaCard = (over) => ({
  id: "idea-0123456789",
  version: "cardv1",
  kind: "idea",
  title: "A small agent runner that keeps its own audit trail",
  source: "x:buildinpublic",
  url: "https://example.test/post/agent-runner",
  sentences: "It touches the Muster gateway: the audit trail could replace our own tick log. Worth a look before WPS lands.",
  project: "pi-agent",
  verdict: "signal",
  taps: [],
  hasReport: false,
  ...over,
});
const ideasPanel = (cards, extra = {}) => panel({ cards, lastRunAt: "2026-10-25T05:50:00.000Z", late: false, ...extra });

const goal = (over) => ({
  code: "PP",
  name: "Pilot path to cutover",
  sub: "Your overnight priority",
  colour: "blue",
  project: "crm-app",
  stations: [
    { id: "s1", name: "Census of the capture", done: true, now: false, owner: "architect", timer: null },
    { id: "s2", name: "Importer", done: false, now: true, owner: "orchestrator", timer: null },
    { id: "s3", name: "Journeys on imported data", done: false, now: false, owner: "orchestrator", timer: null },
    { id: "s4", name: "Cutover rehearsal", done: false, now: false, owner: "operator", timer: null }
  ],
  trains: [{ kind: "work", station: "s2", lane: "census" }],
  lanes: ["census"],
  waitsOn: [],
  ...over,
});

const GATE_OK = { wouldAdmit: true, reason: "", psi: 0, availableMb: 12288, sliceUsedPct: 31, paused: false, devServerWindow: "" };

const machine = (over) => panel({ gate: GATE_OK, tone: null, kills: [], ...over });

const goalsPanel = (groups, sideTrack = []) => panel({ groups, sideTrack });

const group = (project, title, goals) => ({ project, title, goals });

const base = (over) => ({
  generatedAt: READ_AT,
  startedAt: STARTED_AT,
  summary: "2 lanes working · 1 ready for review · 4 goals · nothing stuck",
  panels: {
    lanes: panel({ rows: [lane({ laneId: "census", branch: "lane/census" }), lane({ laneId: "eafix", phase: "review_ready", report: { kind: "review_ready", summary: "Send-back fixed: only photos, documents and the spot-check need --steps.", at: READ_AT } })], hiddenGone: 0 }),
    machine: machine(),
    decisions: panel({ tickets: [ticket()] }),
    goals: goalsPanel([
      group("crm-app", "the CRM app", [
        goal({}),
        goal({ code: "EA", name: "EA contacts capture", sub: "239 of 240 contacts captured", colour: "green",
          stations: [{ id: "r1", name: "Run 1", done: true }, { id: "r2", name: "Run 2", done: true }, { id: "r3", name: "Runner fix", done: false, now: true }, { id: "r4", name: "Contacts export", done: false }],
          trains: [{ kind: "review", station: "r3", lane: "eafix" }], lanes: ["eafix"] })
      ]),
      group("pi-agent", "Your AI team", [
        goal({ code: "CC", name: "Command center", sub: "Your look: Line Map", colour: "gold",
          stations: [{ id: "c1", name: "Backend", done: true }, { id: "c2", name: "Look chosen", done: true }, { id: "c3", name: "Page build", done: false, now: true }, { id: "c4", name: "Answers from the page", done: false }],
          trains: [{ kind: "work", station: "c3", lane: "architect" }], lanes: ["architect"] })
      ])
    ], []),
    team: panel({ members: [
      { role: "architect", held: true, lane: "architect", harness: "claude", model: "Opus 5.5", state: "idle", line: "Blueprint r5 written; waiting for the lanes.", lineAt: READ_AT, lastActiveAt: READ_AT },
      { role: "orchestrator", held: true, lane: "orchestrator", harness: "pi", model: "deepseek-v4.1-flash", state: "running", line: "Dispatching WP1b against fixtures.", lineAt: READ_AT, lastActiveAt: READ_AT },
      { role: "grokbot", held: true, lane: null, harness: "Grok Bot", model: null, state: "idle", line: "Heard you. I will pass it to the architect.", lineAt: READ_AT, lastActiveAt: READ_AT }
    ] }),
    shipped: panel({ items: [
      { at: "2026-10-24T22:31:00.000Z", kind: "merge", text: "EA runner fix merged", sha: "a5e3ca2", goal: "EA" },
      { at: "2026-10-24T23:10:00.000Z", kind: "station", text: "Census of the capture finished", sha: null, goal: "PP" }
    ] }),
    next: panel({ items: [
      { when: "12:00", kind: "timer", text: "Contacts export", who: "starts on its own" },
      { when: "soon", kind: "station", text: "Journeys on imported data · PP", who: "orchestrator" },
      { when: "soon", kind: "review", text: "eafix review", who: "waits for review" }
    ] }),
    delivery: failed("not wired yet (WP5)")
  },
  ...over
});

/** Every state the page must show, by name. */
const withPanels = (name, panels) => {
  const source = name === "base" ? base({}) : STATES[name];
  return { ...source, panels: { ...source.panels, ...panels } };
};
const withIdeas = (name, ideas) => withPanels(name, { ideas });

export const STATES = {
  // All quiet: nothing waits, nothing runs, nothing shipped today.
  "all-quiet": base({
    summary: "No lanes working · nothing ready for review · 1 goal · nothing stuck",
    panels: {
      lanes: panel({ rows: [], hiddenGone: 2 }),
      machine: machine(),
      decisions: panel({ tickets: [] }),
      goals: goalsPanel([group("pi-agent", "Your AI team", [
        goal({ code: "CC", name: "Command center", sub: "Built. Waiting for the next revision.", colour: "gold",
          stations: [{ id: "c1", name: "Backend", done: true }, { id: "c2", name: "Look chosen", done: true }],
          trains: [{ kind: "sched", station: "c2" }], lanes: [] })
      ])], []),
      team: panel({ members: [
        { role: "architect", held: true, lane: null, harness: "claude", model: "Opus 5.5", state: "idle", line: "Quiet.", lineAt: READ_AT, lastActiveAt: READ_AT },
        { role: "orchestrator", held: false, lane: null, harness: null, model: null, state: null, line: null, lineAt: null, lastActiveAt: null },
        { role: "grokbot", held: true, lane: null, harness: "Grok Bot", model: null, state: "idle", line: null, lineAt: null, lastActiveAt: null }
      ] }),
      shipped: panel({ items: [] }),
      next: panel({ items: [] }),
      delivery: failed("not wired yet (WP5)")
    }
  }),

  // A stalled lane: the attention tone in words, never red (D7).
  "stalled-lane": base({
    summary: "1 lane working · nothing ready for review · 4 goals · 1 stuck",
    panels: {
      lanes: panel({ rows: [
        lane({ laneId: "census", state: "stalled", stalled: true, tone: "attention", reason: "stalled", lastActivityMs: 52 * 60000 }),
        lane({ laneId: "eafix", phase: "review_ready" })
      ], hiddenGone: 0 }),
      machine: machine(),
      decisions: panel({ tickets: [] }),
      goals: goalsPanel([group("crm-app", "the CRM app", [
        goal({ trains: [{ kind: "work", station: "s2", lane: "census" }], lanes: ["census"] })
      ])], []),
      team: panel({ members: [
        { role: "architect", held: true, lane: "architect", harness: "claude", model: "Opus 5.5", state: "idle", line: "Waiting on the census lane.", lineAt: READ_AT, lastActiveAt: READ_AT },
        { role: "orchestrator", held: true, lane: "orchestrator", harness: "pi", model: "deepseek-v4.1-flash", state: "running", line: "census has not reported for 52 minutes.", lineAt: READ_AT, lastActiveAt: READ_AT },
        { role: "grokbot", held: true, lane: null, harness: "Grok Bot", model: null, state: "idle", line: null, lineAt: null, lastActiveAt: null }
      ] }),
      shipped: panel({ items: [{ at: "2026-10-24T23:10:00.000Z", kind: "station", text: "Census of the capture finished", sha: null, goal: "PP" }] }),
      next: panel({ items: [{ when: "soon", kind: "station", text: "Importer · PP", who: "orchestrator" }] }),
      delivery: failed("not wired yet (WP5)")
    }
  }),

  // A goal waiting on the operator: red on the train and the status chip.
  "goal-waiting-on-you": base({
    summary: "1 lane working · nothing ready for review · 3 goals · nothing stuck",
    panels: {
      lanes: panel({ rows: [lane({ laneId: "census" })], hiddenGone: 0 }),
      machine: machine(),
      decisions: panel({ tickets: [
        ticket({ id: "ask_rd", code: "VH6", kind: "product-decision", question: "Your 50 labels settle the last two rules. Which rule wins where they disagree?", blocks: ["the Radar AI reader recompute"], ageMs: 2 * 86400000 + 3 * 3600000, stale: true })
      ] }),
      goals: goalsPanel([group("crm-app", "the CRM app", [
        goal({ code: "RD", name: "Radar AI reader", sub: "The model agrees with the rules on 91.8 % of listings", colour: "violet",
          stations: [{ id: "d1", name: "Rules", done: true }, { id: "d2", name: "Model run", done: true }, { id: "d3", name: "Your 50 labels", done: false, now: true }, { id: "d4", name: "Recompute", done: false }],
          trains: [{ kind: "you", station: "d3", ask: "ask_rd" }], lanes: [], waitsOn: ["ask_rd"] }),
        // Waits on an ask the queue on this page does not hold: the id's own short form, and nothing to open.
        goal({ code: "WA", name: "Waiting on an ask the queue does not hold", sub: "The id is all the page has", colour: "teal",
          stations: [{ id: "w1", name: "Read the ask", done: true }, { id: "w2", name: "Answer it", done: false, now: true }],
          trains: [{ kind: "you", station: "w2", ask: "ask_9f2c1e40-1111-2222-3333-444455556666" }], lanes: [], waitsOn: ["ask_9f2c1e40-1111-2222-3333-444455556666"] }),
        goal({ trains: [{ kind: "work", station: "s2", lane: "census" }], lanes: ["census"] })
      ])], []),
      team: panel({ members: [
        { role: "architect", held: true, lane: "architect", harness: "claude", model: "Opus 5.5", state: "idle", line: "Radar waits on your labels.", lineAt: READ_AT, lastActiveAt: READ_AT },
        { role: "orchestrator", held: true, lane: "orchestrator", harness: "pi", model: "deepseek-v4.1-flash", state: "running", line: "Two lanes running.", lineAt: READ_AT, lastActiveAt: READ_AT },
        { role: "grokbot", held: true, lane: null, harness: "Grok Bot", model: null, state: "idle", line: null, lineAt: null, lastActiveAt: null }
      ] }),
      shipped: panel({ items: [] }),
      next: panel({ items: [{ when: "soon", kind: "review", text: "census review", who: "waits for review" }] }),
      delivery: failed("not wired yet (WP5)")
    }
  }),

  // A lane on no goal: the grey side track.
  "lane-on-no-goal": base({
    summary: "2 lanes working · nothing ready for review · 2 goals · nothing stuck",
    panels: {
      lanes: panel({ rows: [lane({ laneId: "census" }), lane({ laneId: "stray", branch: "lane/stray", brief: "Look into the archive" })], hiddenGone: 0 }),
      machine: machine(),
      decisions: panel({ tickets: [] }),
      goals: goalsPanel([group("crm-app", "the CRM app", [
        goal({ trains: [{ kind: "work", station: "s2", lane: "census" }], lanes: ["census"] })
      ])], ["stray"]),
      team: panel({ members: [
        { role: "architect", held: true, lane: "architect", harness: "claude", model: "Opus 5.5", state: "idle", line: null, lineAt: null, lastActiveAt: READ_AT },
        { role: "orchestrator", held: true, lane: "orchestrator", harness: "pi", model: "deepseek-v4.1-flash", state: "running", line: "stray is on no goal yet.", lineAt: READ_AT, lastActiveAt: READ_AT },
        { role: "grokbot", held: true, lane: null, harness: "Grok Bot", model: null, state: "idle", line: null, lineAt: null, lastActiveAt: null }
      ] }),
      shipped: panel({ items: [] }),
      next: panel({ items: [] }),
      delivery: failed("not wired yet (WP5)")
    }
  }),

  // The gateway unreachable: served as a 503 on the state, so the page keeps the last data greyed.
  "gateway-unreachable": base({ unreachable: true }),

  // Twelve goals, nine lanes, thirty tickets.
  busy: (() => {
    const projects = [["crm-app", "the CRM app"], ["acme-realty-website", "Acme Realty website"], ["pi-agent", "Your AI team"]];
    const colours = ["blue", "green", "violet", "orange", "teal", "gold", "brown", "magenta"];
    const goals = [];
    for (let index = 0; index < 12; index += 1) {
      const stations = Array.from({ length: 4 + (index % 4) }, (_, at) => ({ id: `g${index}s${at}`, name: `Station ${at + 1} of goal ${index + 1}`, done: at === 0, now: at === 1, owner: "orchestrator", timer: null }));
      goals.push(goal({
        code: String.fromCharCode(65 + (index % 26)) + String.fromCharCode(65 + ((index * 3) % 26)),
        name: `Goal ${index + 1} on the line map`,
        sub: `Working note ${index + 1}, one line of it`,
        colour: colours[index % colours.length],
        project: projects[index % projects.length][0],
        stations,
        trains: index % 3 === 0 ? [{ kind: "review", station: stations[1].id, lane: `lane-${index}` }] : [{ kind: "work", station: stations[1].id, lane: `lane-${index}` }],
        lanes: [`lane-${index}`],
        waitsOn: index === 4 ? ["ask_busy_4"] : []
      }));
    }
    const lanes = Array.from({ length: 9 }, (_, index) => lane({ laneId: `lane-${index}`, branch: `lane/work-${index}`, report: index % 3 === 0 ? { kind: "review_ready", summary: `Lane ${index} is ready for review.`, at: READ_AT } : null, phase: index % 3 === 0 ? "review_ready" : null }));
    const tickets = Array.from({ length: 30 }, (_, index) => ticket({
      id: `ask_busy_${index}`, code: `V${String.fromCharCode(65 + (index % 26))}${index}`,
      kind: ["product-decision", "authorization", "credential", "human-login", "review", "operator-action"][index % 6],
      question: `Decision ${index + 1}: ${index % 4 === 0 ? "which of the two readings should the lane take, and why?" : "the lane needs your word before it continues"}`,
      blocks: index % 5 === 0 ? [`work item ${index}`] : [],
      ageMs: (index % 9) * 8 * 3600000,
      stale: index % 9 >= 6
    }));
    return base({
      summary: "9 lanes working · 3 ready for review · 12 goals · 2 stuck",
      panels: {
        lanes: panel({ rows: lanes.concat([lane({ laneId: "lane-stuck", state: "blocked", stalled: true, tone: "attention" })]), hiddenGone: 0 }),
        machine: machine({ gate: { ...GATE_OK, wouldAdmit: false, reason: "PSI 47 over 40", availableMb: 1400, psi: 47 }, tone: "red", kills: [{ at: "2026-10-24T23:58:00.000Z", text: "Stopped a typecheck at 1.4 GB free." }] }),
        decisions: panel({ tickets }),
        goals: goalsPanel(projects.map(([project, title], index) => group(project, title, goals.filter((_, at) => at % 3 === index))), []),
        team: panel({ members: [
          { role: "architect", held: true, lane: "architect", harness: "claude", model: "Opus 5.5", state: "idle", line: "Thirty tickets, nine lanes. The queue is yours.", lineAt: READ_AT, lastActiveAt: READ_AT },
          { role: "orchestrator", held: true, lane: "orchestrator", harness: "pi", model: "deepseek-v4.1-flash", state: "running", line: "Nine lanes in flight, two stuck.", lineAt: READ_AT, lastActiveAt: READ_AT },
          { role: "grokbot", held: true, lane: null, harness: "Grok Bot", model: null, state: "idle", line: "Ready when you are.", lineAt: READ_AT, lastActiveAt: READ_AT }
        ] }),
        shipped: panel({ items: Array.from({ length: 8 }, (_, index) => ({ at: `2026-10-24T${String(14 + (index % 9)).padStart(2, "0")}:15:00.000Z`, kind: "merge", text: `Change ${index + 1} merged`, sha: `a5e3ca${index}`, goal: null })) }),
        next: panel({ items: Array.from({ length: 6 }, (_, index) => ({ when: index === 0 ? "12:00" : "soon", kind: index === 0 ? "timer" : index % 2 === 0 ? "station" : "review", text: `Next item ${index + 1}`, who: index === 0 ? "starts on its own" : "orchestrator" })) }),
        delivery: failed("not wired yet (WP5)")
      }
    });
  })(),

  // Long Cyrillic names, as the register may hold them.
  cyrillic: base({
    summary: "2 ленти работят · 1 чака преглед · 2 цели · нищо не е заседнало",
    panels: {
      lanes: panel({ rows: [
        lane({ laneId: "l3-импорт", branch: "lane/импорт-на-контакти", brief: "Импортиране на контактите от ЕА в the CRM app без загуба на снимки и документи", lastMessage: "Проверявам полетата, които нямат колона в the CRM app, и ги записвам в списъка с липси." }),
        lane({ laneId: "l4-снимки", branch: "lane/снимки", brief: "Снимки и биографии на екипа" })
      ], hiddenGone: 0 }),
      machine: machine(),
      decisions: panel({ tickets: [
        ticket({ id: "ask_bg", code: "ВЖ4", kind: "authorization", question: "Да пусна ли пълния експорт на контактите от ЕА тази нощ, или само проверка на първите двадесет?", blocks: ["нощния експорт на контактите"], ageMs: 5 * 3600000 })
      ] }),
      goals: goalsPanel([group("crm-app", "the CRM app", [
        goal({ code: "ЕА", name: "Извличане на контактите от ЕА", sub: "239 от 240 контакта са извлечени · ВР24-24", colour: "green",
          stations: [{ id: "б1", name: "Първи пуск", done: true }, { id: "б2", name: "Втори пуск", done: true }, { id: "б3", name: "Поправка на runner-а", done: false, now: true }, { id: "б4", name: "Експорт на контактите в the CRM app", done: false }],
          trains: [{ kind: "work", station: "б3", lane: "l3-импорт" }], lanes: ["l3-импорт"] })
      ]), group("acme-realty-website", "Acme Realty website", [
        goal({ code: "СН", name: "Снимки и биографии на екипа", sub: "Избор на снимка, гласуване за обща снимка и биографии", colour: "teal",
          stations: [{ id: "ф1", name: "Първи пакет", done: true }, { id: "ф2", name: "Втори пакет", done: false, now: true }],
          trains: [{ kind: "work", station: "ф2", lane: "l4-снимки" }], lanes: ["l4-снимки"] })
      ])], []),
      team: panel({ members: [
        { role: "architect", held: true, lane: "architect", harness: "claude", model: "Opus 5.5", state: "idle", line: "Чакам отговора ти за нощния експорт.", lineAt: READ_AT, lastActiveAt: READ_AT },
        { role: "orchestrator", held: true, lane: "orchestrator", harness: "pi", model: "deepseek-v4.1-flash", state: "running", line: "Две ленти работят по ЕА и по снимките.", lineAt: READ_AT, lastActiveAt: READ_AT },
        { role: "grokbot", held: true, lane: null, harness: "Grok Bot", model: null, state: "idle", line: "Ще предам въпроса на архитекта.", lineAt: READ_AT, lastActiveAt: READ_AT }
      ] }),
      shipped: panel({ items: [{ at: "2026-10-24T22:40:00.000Z", kind: "merge", text: "Поправката на runner-а е слята", sha: "c288381", goal: "ЕА" }] }),
      next: panel({ items: [{ when: "12:00", kind: "timer", text: "Нощен експорт на контактите", who: "стартира само" }] }),
      delivery: failed("not wired yet (WP5)")
    }
  }),

  // Markup in every field the page shows: it must read as text, and no element may be made from it.
  "injected-markup": base({
    summary: "1 lane working · nothing ready for review · 1 goal · nothing stuck",
    panels: {
      lanes: panel({ rows: [lane({ laneId: "census", lastMessage: "<img src=x onerror=alert(1)> and <b>x</b> in a lane line" })], hiddenGone: 0 }),
      machine: machine(),
      decisions: panel({ tickets: [ticket({ question: "<img src=x onerror=alert(1)> and <b>x</b> in a question", options: ["<b>x</b>"], recommendation: "<b>x</b>" })] }),
      goals: goalsPanel([group("crm-app", "the CRM app", [
        goal({ name: "<img src=x onerror=alert(1)> and <b>x</b> in a goal name", sub: "<b>x</b>", trains: [{ kind: "work", station: "s2", lane: "census" }], lanes: ["census"] })
      ])], []),
      team: panel({ members: [
        { role: "architect", held: true, lane: "architect", harness: "claude", model: "Opus 5.5", state: "idle", line: "<b>x</b>", lineAt: READ_AT, lastActiveAt: READ_AT },
        { role: "orchestrator", held: true, lane: "orchestrator", harness: "pi", model: "deepseek-v4.1-flash", state: "running", line: "<img src=x onerror=alert(1)>", lineAt: READ_AT, lastActiveAt: READ_AT },
        { role: "grokbot", held: true, lane: null, harness: "Grok Bot", model: null, state: "idle", line: null, lineAt: null, lastActiveAt: null }
      ] }),
      shipped: panel({ items: [{ at: "2026-10-24T22:40:00.000Z", kind: "merge", text: "<b>x</b> merged", sha: "c288381", goal: null }] }),
      next: panel({ items: [{ when: "soon", kind: "station", text: "<img src=x onerror=alert(1)> · PP", who: "<b>x</b>" }] }),
      delivery: failed("not wired yet (WP5)")
    }
  })
};

// NLP states derive from the states above, so they are added after the table exists.
Object.assign(STATES, {
  // NLP (R6.1, acceptance 3): the Ideas list and the ticket taps.
  "ideas-none": withIdeas("all-quiet", ideasPanel([])),
  "ideas-late": withIdeas("all-quiet", ideasPanel([], { lastRunAt: "2026-10-24T05:50:00.000Z", late: true })),
  "ideas-three": withIdeas("base", ideasPanel([
    ideaCard({}),
    ideaCard({ id: "idea-1111111111", title: "Creator proposal: @agentbench keeps shipping runnable agent evals", kind: "creator", source: "x:agentbench", verdict: "fact", project: "pi-agent",
      sentences: "Four posts this week with runnable code. A creator worth following for the harness evals.", url: "https://example.test/agentbench" }),
    ideaCard({ id: "idea-2222222222", title: "Why real estate CRMs still lose the phone call", source: "youtube:UCgreg", sourceName: "Greg Isenberg", verdict: "unknown", project: "crm-app", url: "https://example.test/watch?v=abc",
      sentences: "Judged on its title and description only. It may touch the the CRM app call log." })
  ])),
  "ideas-report": withIdeas("base", ideasPanel([
    ideaCard({ taps: ["dig-deeper"], hasReport: true, title: "Prompt caching across subagents: the numbers" }),
    ideaCard({ id: "idea-3333333333", taps: ["dig-deeper"], title: "A tool-call tracer for Claude Code hooks" }),
    ideaCard({ id: "idea-4444444444", title: "Neon branching for per-lane databases" })
  ])),
  "ideas-error": withIdeas("base", failed("the research desk could not be read: ledger socket refused")),
  "ideas-injected": withIdeas("base", ideasPanel([
    ideaCard({ title: "<img src=x onerror=alert(1)> and <b>x</b> in a title", sentences: "<img src=x onerror=alert(1)> <a href=\"javascript:alert(1)\">click</a>", url: "javascript:alert(1)", sourceName: "<b>x</b> source" }),
    ideaCard({ id: "idea-5555555555", title: "A card whose link is http, not https", url: "http://example.test/plain" })
  ])),
  "tickets-sitting-30": (() => {
    const kinds = ["product-decision", "authorization", "credential", "human-login", "review", "operator-action"];
    const tickets = Array.from({ length: 30 }, (_, index) => ticket({
      id: `ask_sit_${index}`, code: `V${String.fromCharCode(65 + (index % 26))}${index}`, kind: kinds[index % 6],
      question: `Ticket ${index + 1}: ${index % 3 === 0 ? "which of the two readings should the lane take, and why?" : "the lane needs your word before it continues"}`,
      blocks: index % 4 === 0 ? [`work item ${index}`, `work item ${index + 1}`] : [],
      options: index % 2 === 0 ? ["Yes, go ahead", "No, hold it", "Ask me again tomorrow"] : [],
      recommendation: index % 2 === 0 ? "yes, go ahead" : null,
      ageMs: (index % 9) * 8 * 3600000, stale: index % 9 >= 6
    }));
    return withPanels("base", { decisions: panel({ tickets }), ideas: ideasPanel([ideaCard({})]) });
  })(),
  "ask-prepared": withPanels("base", { decisions: panel({ tickets: [ticket({ id: "ask_prep", code: "VR-T1", kind: "authorization", question: "May the lane push its branch to dev?", options: ["Yes, to dev only", "No", "Ask me later"], recommendation: "yes, to dev only", blocks: ["lane nlp"] })] }) }),
  "ask-unprepared": withPanels("base", { decisions: panel({ tickets: [ticket({ id: "ask_bare", code: "VR-T2", kind: "authorization", question: "Which provider should carry the morning job?", options: [], recommendation: null })] }) }),
  "ask-five-cyrillic": withPanels("base", { decisions: panel({ tickets: [ticket({ id: "ask_bg5", code: "ВЖ5", kind: "product-decision",
    question: "Как да се покаже списъкът с контактите от ЕА, когато липсват снимки и документи за част от тях?",
    options: ["Показвай всички контакти, а липсващите снимки отбелязвай с празно място", "Скрий контактите без снимка до следващото извличане", "Покажи ги в отделен списък „За допълване“ с причината за всяка липса", "Питай ме за всеки контакт поотделно, когато го отворя за първи път", "Не показвай нищо, докато не са извлечени всички 240 контакта"],
    recommendation: "Покажи ги в отделен списък „За допълване“ с причината за всяка липса", blocks: ["нощния експорт на контактите", "снимките на екипа"] })] }) })
});

// Every older state reads a desk with nothing new on it, so only the states above show cards.
for (const state of Object.values(STATES)) {
  if (state.panels && !("ideas" in state.panels)) state.panels.ideas = ideasPanel([]);
}

// WP1c: actions a process on the PC asked for. The phone's state carries the exact payload and the digest Confirm sends back;
// the PC's state carries neither, so its page can only say that the action waits for the tap on the phone.
const PC_WAITING = [
  { id: "5d1c2a64-7b0e-4a58-9c13-0f6e2a8d4b71", kind: "message", payload: { action: "message", to: "architect", text: "Move the release to Friday and tell the orchestrator." }, digest: "0123456789abcdef0123456789abcdef", createdAt: "2026-10-25T01:27:00.000Z", expiresAt: "2026-10-25T01:32:00.000Z" },
  { id: "9a3e7f10-2c44-4d6b-8e59-1b7d3c5a6f02", kind: "stop", payload: { action: "stop", lane: "census" }, digest: "fedcba9876543210fedcba9876543210", createdAt: "2026-10-25T01:28:30.000Z", expiresAt: "2026-10-25T01:33:30.000Z" }
];
STATES["pc-view-phone"] = withPanels("busy", { pendingPc: panel(PC_WAITING) });
STATES["pc-view-pc"] = withPanels("busy", { pendingPc: panel(PC_WAITING.map(({ id, kind, createdAt, expiresAt }) => ({ id, kind, createdAt, expiresAt }))) });

/** The live-session feed (WPF's answer), per lane, for the fixtures that open a lane. */
export const FEEDS = {
  census: { lane: "census", readAt: READ_AT, total: 4, messages: [
    { index: 0, role: "user", at: "2026-10-25T01:25:00.000Z", content: "Brief read: census of the run, offline and proposals only." },
    { index: 1, role: "assistant", at: "2026-10-25T01:26:00.000Z", content: "Opened the run folder read-only: 239 contacts, 3226 photos, 51 documents." },
    { index: 2, role: "assistant", at: "2026-10-25T01:28:00.000Z", content: "Mapping each contact field to a the CRM app column." },
    { index: 3, role: "assistant", at: "2026-10-25T01:30:00.000Z", content: "Fields with no column go on the gap list for the next station." }
  ], notes: [] },
  eafix: { lane: "eafix", readAt: READ_AT, total: 3, messages: [
    { index: 0, role: "user", at: "2026-10-25T01:20:00.000Z", content: "Send-back: only photos, documents and the spot check need --steps." },
    { index: 1, role: "assistant", at: "2026-10-25T01:27:00.000Z", content: "Failing first: 8 tests red. After the fix: 60 of 60 green." },
    { index: 2, role: "assistant", at: "2026-10-25T01:29:00.000Z", content: "Report filed. Waiting for the architect." }
  ], notes: [] }
};
