import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, PresentationFile } from "@oai/artifact-tool";

const WORK = "/Users/josephkaram/Downloads/goalie/.deck_work/inspect_figma";
const INPUT = path.join(WORK, "template-starter.pptx");
const OUTPUT = "/Users/josephkaram/Downloads/goalie/GOALIE_3_Minute_Presentation.pptx";
const HERO = path.join(WORK, "goalie-cover.png");
const RENDER_DIR = path.join(WORK, "final-render");
const LAYOUT_DIR = path.join(WORK, "final-layout");

async function writeBlob(filePath, blob) {
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

let importedRecords = [];
const usedTextIds = new Set();

function replaceText(presentation, plannedId, from, to) {
  const record = importedRecords.find((item) => item.kind === "textbox" && item.text === from && !usedTextIds.has(item.id));
  if (!record) throw new Error(`Could not resolve imported text for planned target ${plannedId}: ${from}`);
  usedTextIds.add(record.id);
  const target = presentation.resolve(record.id);
  if (from.includes("\n")) target.text = to;
  else target.text.replace(from, to);
}

function setNotes(slide, talkTrack, sources) {
  const block = [
    talkTrack,
    "",
    "[Sources]",
    ...sources.map((source) => `- ${source}`),
    "[/Sources]",
  ].join("\n");
  slide.speakerNotes.textFrame.setText(block);
  slide.speakerNotes.setVisible(true);
}

async function main() {
  await fs.mkdir(RENDER_DIR, { recursive: true });
  await fs.mkdir(LAYOUT_DIR, { recursive: true });
  const presentation = await PresentationFile.importPptx(await FileBlob.load(INPUT));
  const imported = await presentation.inspect({
    kind: "textbox,shape,image",
    include: "id,slide,name,text",
    maxChars: 60000,
  });
  importedRecords = imported.ndjson.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

  const replacements = [
    ["sh/a54ruxc3", "✦  BUILD DAY ENTRY", "✦  LONG-HORIZON BUILD DAY"],
    ["sh/p4valsbi", "COVER", "GOALIE"],
    ["sh/n2tsjits", "LONG-HORIZON AGENTS BUILD DAY", "LONG-HORIZON AGENTS BUILD DAY"],
    ["sh/21krqdc7", "PROJECT NAME", "GOALIE"],
    ["sh/10bah8vm", "One sentence that makes the product impossible to misunderstand.", "The champion of long-horizon harnesses."],
    ["sh/0f29onu1", "TEAM NAME  ·  AUG 22, 2026", "JOSEPH KARAM  ·  AUG 22, 2026"],
    ["sh/6hob2dkr", "HACKATHON ENTRY TEMPLATE", "OFFENSE  ·  DEFENSE  ·  EVIDENCE"],
    ["sh/rixsbilc", "REPLACE EVERY PLACEHOLDER BEFORE PRESENTING", "THE HARNESS THAT LEARNS FROM EVERY MISS"],

    ["sh/07qpofqp", "✦  BUILD DAY ENTRY", "✦  LONG-HORIZON BUILD DAY"],
    ["sh/z6h8fa94", "PROBLEM", "THE CHALLENGE"],
    ["sh/9cjqlkr6", "CONTENTS", "THE SETUP"],
    ["sh/oba9szql", "Problem\nWho feels it\nWhy it persists\nWhat it costs", "Ball\nGoal\nDefense\nCoach"],
    ["sh/7id4fmpo", "01 / PROBLEM", "01 / THE CHALLENGE"],
    ["sh/sjm5orq9", "The problem is visible.\nThe cost is compounding.", "A goal is easy.\nA defended goal is not."],
    ["sh/tkvmhw7e", "Describe the user, the moment the workflow breaks, and why existing solutions still leave the hard part unresolved.", "Agents can take a task. Long-horizon work adds resistance: mistakes compound before the finish."],
    ["sh/ul4nq1oz", "XX%", "1st"],
    ["sh/fmdoj6pk", "PRIMARY COST OR FAILURE RATE\nAdd the source and sample size in one line.", "ATTEMPT\nEven strong players need a coach."],
    ["sh/hov6lw7q", "The audience should feel the problem before they hear the feature list.", "The question is not whether an agent can try. It is how the agent improves."],

    ["sh/p8fu9gzq", "✦  BUILD DAY ENTRY", "✦  LONG-HORIZON BUILD DAY"],
    ["sh/v29476x4", "02 / THE INSIGHT", "02 / THE INSIGHT"],
    ["sh/u10ne1gj", "“The non-obvious thing\nwe learned goes here.”", "“Agents need a coach,\nnot one perfect first try.”"],
    ["sh/8zi5cbyd", "Explain why this insight changes the design of the product—not merely how you describe it.", "Feedback turns each failed attempt into a better scoring strategy."],
    ["sh/7yp436hs", "EVIDENCE / OBSERVATION / USER QUOTE", "LONG-HORIZON DESIGN PRINCIPLE"],

    ["sh/ex4721s3", "✦  BUILD DAY ENTRY", "✦  LONG-HORIZON BUILD DAY"],
    ["sh/nqx8jqtk", "A focused system that closes the loop.", "Goalie turns every miss into the next attempt."],
    ["sh/mporqlcz", "Replace these three verbs with the core behavior of your product.", "Two agent roles. One evidence-driven loop."],
    ["sh/e147mlc3", "OBSERVE", "OFFENSE"],
    ["sh/l0zatkby", "What signal enters the system?", "Takes the shot with the context it has"],
    ["sh/547apoju", "DECIDE", "DEFENSE"],
    ["sh/i1gbutkj", "What reasoning or model changes the outcome?", "Scores the result and exposes the biggest gap"],
    ["sh/h07alojy", "VERIFY", "RETRY"],
    ["sh/uxwbq9k7", "How does the system know it worked?", "Feeds the gap back until the final gate passes"],
    ["sh/vy5sje1s", "ONE LINE ON THE DELIGHTFUL DIFFERENCE", "POSITIVE → GOAL  ·  NEGATIVE → SAVE  ·  UNCERTAIN → VAR"],

    ["sh/lkv61kvy", "✦  BUILD DAY ENTRY", "✦  LONG-HORIZON BUILD DAY"],
    ["sh/pgb6dkfq", "04 / PRODUCT DEMO", "04 / PRODUCT DEMO"],
    ["sh/ov2pkfy5", "Show the product doing the hard part.", "Watch the improvement loop—not just the final answer."],
    ["sh/ahk7mpgb", "DROP PRODUCT DEMO\nOR SCREENSHOT HERE", "PRE-RECORDED DEMO\nGOAL  ·  SAVE  ·  RETRY"],
    ["sh/cjmpofy1", "Caption the moment judges should notice. Keep it specific.", "Notice how the critic’s largest gap becomes the next attempt’s coaching signal."],
    ["sh/zmdojuxs", "LIVE DEMO →", "PLAY DEMO →"],

    ["sh/832l4fil", "✦  BUILD DAY ENTRY", "✦  LONG-HORIZON BUILD DAY"],
    ["sh/72t4vah0", "05 / SYSTEM", "05 / SYSTEM"],
    ["sh/w7ml8zix", "The architecture protects\nthe product promise.", "The harness owns\nthe match."],
    ["sh/hsvm14zi", "Name the one technical choice that makes the demo credible: persistence, verification, latency, data access, or safety.", "Agents propose. The host owns the contract, checks, state, budget, and final gate."],
    ["sh/u5436p0r", "TECHNICAL EDGE", "TECHNICAL EDGE"],
    ["sh/v6d4zuhc", "One concise sentence on what is genuinely hard to reproduce.", "Fresh critics + hard checks stop confident text from becoming false success."],
    ["sh/ep872dkv", "INPUT", "GOAL"],
    ["sh/1sz6x8jm", "Trigger, context, or user intent", "Confirmed success contract"],
    ["sh/sn650325", "AGENT LOOP", "OFFENSE"],
    ["sh/bi1o3i1o", "Plan → tool use → checkpoint", "Plan → tools → checkpoint"],
    ["sh/cv6ts3uh", "VERIFIER", "DEFENSE"],
    ["sh/zyxcnyds", "Environment state or metric", "Critic + deterministic checks"],
    ["sh/f2tcredo", "OUTCOME", "CHAMPION"],
    ["sh/u1kbi9c3", "Action the user can trust", "Verified integration artifact"],

    ["sh/zyhwnq5o", "✦  BUILD DAY ENTRY", "✦  LONG-HORIZON BUILD DAY"],
    ["sh/yx8felo3", "EVIDENCE", "THE GATE"],
    ["sh/83axkv65", "06 / MEASUREMENT", "06 / THE GATE"],
    ["sh/n21wrq5k", "A credible win in one honest measurement.", "Victory requires the final gate—not a good-looking answer."],
    ["sh/m1sfiloz", "PRIMARY METRIC", "REQUIRED GATES"],
    ["sh/xs3yx0nm", "XX%", "100%"],
    ["sh/wraxof61", "Describe what changed, compared with what baseline, over what sample.", "Hard checks and the latest fresh audit must pass."],
    ["sh/18bq98za", "XX×", "1"],
    ["sh/elkred0j", "FASTER", "GAP"],
    ["sh/f6t87yh4", "Time-to-result versus baseline", "Largest evidence gap coaches retry"],
    ["sh/pcvqdsz6", "XX", "3"],
    ["sh/294rid0f", "RUNS", "STATES"],
    ["sh/3ad8bih0", "State the sample size", "GOAL · SAVE · VAR"],
    ["sh/5grq1oz2", "XX%", "0"],
    ["sh/nahc7m1k", "SUCCESS", "SHORTCUTS"],
    ["sh/m98be1kz", "Define success precisely", "Failed checks cannot be waived"],
    ["sh/9wzu9wja", "REPLACE ALL SAMPLE VALUES · CITE THE SOURCE", "BOUNDED BY TIME  ·  TURNS  ·  COST  ·  PLATEAU"],

    ["sh/j2pc7uxg", "✦  BUILD DAY ENTRY", "✦  LONG-HORIZON BUILD DAY"],
    ["sh/i1wbypgv", "WHY NOW", "WHY FAILURE"],
    ["sh/k3yd0zel", "07 / WHY THIS WINS", "07 / WHY FAILURE MATTERS"],
    ["sh/z6lcvqxw", "Why this idea matters now.", "Failure is fuel for long-horizon agents."],
    ["sh/q9gb2lo7", "A capability shift", "Longer tasks"],
    ["sh/rapcbq5s", "Name the model, platform, or behavior that only recently became possible.", "More coupled steps create more chances to drift."],
    ["sh/edgv65oj", "A distribution advantage", "Coached recovery"],
    ["sh/zepcfa54", "Explain how this reaches users faster than a technically similar product.", "Each miss becomes focused context for the next attempt."],
    ["sh/mh0va5of", "A compounding moat", "Durable progress"],
    ["sh/ni9cja50", "Identify the data, workflow, or feedback loop that improves with every use.", "Evidence, checkpoints, and fresh audits preserve what was learned."],

    ["sh/ahsfq1kr", "✦  BUILD DAY ENTRY", "✦  LONG-HORIZON BUILD DAY"],
    ["sh/bi1gj61w", "TEAM + NEXT STEP", "CLOSE"],
    ["sh/pgzyhwj6", "08 / CLOSE", "08 / CLOSE"],
    ["sh/2d8fmhkf", "The team can ship\nthe next version.", "Failure is not the opposite\nof success. It is the loop."],
    ["sh/nehgfm10", "NAME / ROLE", "JOSEPH KARAM"],
    ["sh/0rqxkr29", "One line of unusually relevant experience.", "Creator and builder of Goalie."],
    ["sh/1szydwju", "NAME / ROLE", "GOALIE CLI"],
    ["sh/hw7m1o7m", "One line of unusually relevant experience.", "Open-source harness for long-horizon coding agents."],
    ["sh/wvy5sjq1", "NAME / ROLE", "YOUR NEXT MOVE"],
    ["sh/vap4zepg", "One line of unusually relevant experience.", "Try it on a hard task. Break it. Improve it."],
    ["sh/987mx47a", "WHAT WE NEED NEXT", "WHAT I NEED NEXT"],
    ["sh/87e5ozq5", "A pilot partner, a technical collaborator, or one concrete decision.", "Find Goalie on GitHub—and give the project a star."],
    ["sh/7654vu9k", "DEMO URL / QR", "GITHUB / QR"],
    ["sh/m5w3m98z", "Make the final request easy to answer.", "STAR GOALIE →"],
  ];

  for (const [id, from, to] of replacements) replaceText(presentation, id, from, to);

  const heroRecord = importedRecords.find((item) => item.kind === "image" && item.slide === 1);
  if (!heroRecord) throw new Error("Could not resolve inherited cover image.");
  const hero = presentation.resolve(heroRecord.id);
  const bytes = await fs.readFile(HERO);
  const blob = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const frame = hero.frame;
  const crop = hero.crop;
  const fit = hero.fit;
  hero.replace({ blob, contentType: "image/png", alt: "Soccer ball facing a goal under stadium lights", ...(fit ? { fit } : {}) });
  hero.frame = frame;
  hero.crop = crop;

  const notes = [
    {
      talk: "0:00–0:12 — Hello everyone, my name is Joseph Karam, and this is Goalie—the champion of long-horizon harnesses.",
      sources: ["OpenAI ImageGen — generated soccer-field cover visual", "https://blog.agihouse.org/posts/long-horizon-agents-a-technical-primer — inherited deck context"],
    },
    {
      talk: "0:12–0:48 — Quick question: who watched the World Cup this summer? Raise your hand. If you didn’t, are you at least familiar with soccer—or fútbol? Great. Give anyone here a ball and an empty goal, and I hope we can score. Put Argentina’s World Cup team in defense, and unless you’re Lamine Yamal, probably not on the first try. Long-horizon agent tasks work the same way: the goal is clear, but the path is defended by compounding mistakes.",
      sources: ["https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/articles/spain-argentina-final-report-highlights"],
    },
    {
      talk: "0:48–1:06 — But add a coach after every miss—someone who explains how to improve the scoring strategy—and eventually you score. I believe long-horizon agents need that same relationship with failure.",
      sources: ["User-provided presentation script"],
    },
    {
      talk: "1:06–1:32 — That is Goalie. Offense tackles the problem with the context it has. Defense scrutinizes the result, scores it, and identifies the biggest gap. That gap goes back to offense for the next attempt. Positive trajectory plays GOAL, negative plays SAVE, and uncertainty goes to VAR.",
      sources: ["README.md", "docs/architecture.md"],
    },
    {
      talk: "1:32–1:58 — Let’s see it. Full disclosure: long-horizon tasks take a while, so this is prerecorded—but it works. Watch the feedback loop: each defensive save becomes the next offensive coaching signal. [Play approximately 20 seconds of the recording. Pause after the first save-to-retry transition.]",
      sources: ["docs/demo.md"],
    },
    {
      talk: "1:58–2:18 — Under the animation, the harness owns the match: the goal contract, deterministic checks, durable state, budget, and final gate. The offense proposes; the defense critiques; the host verifies. The animation is the broadcast, not the proof.",
      sources: ["README.md", "docs/architecture.md"],
    },
    {
      talk: "2:18–2:34 — The task only wins when every required check and the fresh final audit pass. A confident answer cannot waive failed evidence. Goalie keeps retrying within explicit time, turn, cost, and plateau limits.",
      sources: ["README.md", "docs/architecture.md"],
    },
    {
      talk: "2:34–2:53 — So why does the goalie keep blocking the model? Because failure is fuel. Argentina lost to Saudi Arabia in its first 2022 World Cup match, learned, recovered, and became champion. Humans use failure to get better. Agents should too.",
      sources: ["https://www.fifa.com/es/articles/el-camino-de-argentina-hacia-el-titulo-de-la-copa-mundial"],
    },
    {
      talk: "2:53–3:00 — People say, ‘Failure is not an option.’ For the agentic future, I believe failure is the only option—because it is how the next attempt becomes better. Thank you. Find Goalie on GitHub; I need stars.",
      sources: ["User-provided presentation script"],
    },
  ];

  presentation.slides.items.forEach((slide, index) => setNotes(slide, notes[index].talk, notes[index].sources));

  const inspection = await presentation.inspect({
    kind: "slide,textbox,shape,image,notes,layout",
    include: "id,slide,name,title,text,textPreview,bbox,isPlaceholder,placeholders",
    maxChars: 60000,
  });
  await fs.writeFile(path.join(WORK, "final-inspect.ndjson"), inspection.ndjson, "utf8");

  for (const [index, slide] of presentation.slides.items.entries()) {
    const stem = `slide-${String(index + 1).padStart(2, "0")}`;
    await writeBlob(path.join(RENDER_DIR, `${stem}.png`), await presentation.export({ slide, format: "png", scale: 2 }));
    await fs.writeFile(path.join(LAYOUT_DIR, `${stem}.layout.json`), await (await slide.export({ format: "layout" })).text(), "utf8");
  }
  await writeBlob(path.join(WORK, "final-montage.webp"), await presentation.export({ format: "webp", montage: true, scale: 1 }));
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(OUTPUT);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
