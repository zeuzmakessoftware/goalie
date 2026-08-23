import fs from "node:fs/promises";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const OUT = "/Users/josephkaram/Downloads/goalie/GOALIE_hackathon_entry_template.pptx";
const PREVIEW_DIR = "/Users/josephkaram/Downloads/goalie/.codex_tmp/agi_blog_hackathon_deck/rendered";
const HERO = "/Users/josephkaram/Downloads/goalie/.codex_tmp/agi_blog_hackathon_deck/cover-hero.png";

const W = 1280;
const H = 720;
const C = {
  ink: "#0A0A0A",
  paper: "#F4F3EE",
  white: "#FFFFFF",
  muted: "#6D6B65",
  rule: "#CFCDC5",
  accent: "#9B2F86",
  fog: "#BEC4C4",
  fogDark: "#8F9696",
};
const DISPLAY = "Aptos Display";
const SANS = "Aptos";
const SERIF = "Georgia";
const SOURCE_URL = "https://blog.agihouse.org/posts/long-horizon-agents-a-technical-primer";

function addText(slide, text, x, y, w, h, opts = {}) {
  const shape = slide.shapes.add({
    geometry: "textbox",
    name: opts.name,
    position: { left: x, top: y, width: w, height: h },
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  shape.text = text;
  shape.text.style = {
    fontSize: opts.size ?? 20,
    typeface: opts.font ?? SANS,
    color: opts.color ?? C.ink,
    bold: opts.bold ?? false,
    italic: opts.italic ?? false,
    alignment: opts.align ?? "left",
    verticalAlignment: opts.valign ?? "top",
    lineSpacing: opts.lineSpacing ?? 1.0,
    autoFit: opts.autoFit ?? "shrinkText",
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
  };
  return shape;
}

function rect(slide, x, y, w, h, fill, name, lineFill = "none", lineWidth = 0) {
  return slide.shapes.add({
    geometry: "rect",
    name,
    position: { left: x, top: y, width: w, height: h },
    fill,
    line: { style: "solid", fill: lineFill, width: lineWidth },
  });
}

function circle(slide, x, y, d, fill, lineFill = "none", lineWidth = 0) {
  return slide.shapes.add({
    geometry: "ellipse",
    position: { left: x, top: y, width: d, height: d },
    fill,
    line: { style: "solid", fill: lineFill, width: lineWidth },
  });
}

function topBar(slide, index, label, dark = false) {
  rect(slide, 0, 0, W, 58, dark ? C.paper : C.ink, "top-bar");
  addText(slide, "✦  BUILD DAY ENTRY", 30, 18, 260, 22, {
    size: 14, font: SANS, bold: true, color: dark ? C.ink : C.white,
  });
  addText(slide, label.toUpperCase(), 820, 18, 330, 22, {
    size: 12, font: SANS, color: dark ? C.muted : "#C9C7C0", align: "right",
  });
  addText(slide, String(index).padStart(2, "0"), 1180, 18, 70, 22, {
    size: 13, font: SANS, bold: true, color: dark ? C.ink : C.white, align: "right",
  });
}

function eyebrow(slide, text, x = 64, y = 92, color = C.muted) {
  addText(slide, text.toUpperCase(), x, y, 500, 24, {
    size: 13, font: SANS, bold: true, color,
  });
}

function notes(slide, extra = "") {
  slide.speakerNotes.textFrame.setText(
    `[Sources]\n- ${SOURCE_URL} (visual style reference)${extra ? `\n- ${extra}` : ""}\n[/Sources]`
  );
}

async function imageBytes(path) {
  const b = await fs.readFile(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

async function main() {
  await fs.mkdir(PREVIEW_DIR, { recursive: true });
  const p = Presentation.create({ slideSize: { width: W, height: H } });

  // 01 — Cover
  {
    const s = p.slides.add();
    s.background.fill = C.paper;
    topBar(s, 1, "Cover");
    eyebrow(s, "Long-horizon agents build day", 64, 96);
    addText(s, "PROJECT NAME", 64, 135, 1020, 118, {
      name: "project-name", size: 62, font: DISPLAY, color: C.ink, lineSpacing: 0.9,
    });
    addText(s, "One sentence that makes the product impossible to misunderstand.", 68, 267, 850, 66, {
      name: "one-line-value-proposition", size: 24, font: SERIF, color: C.ink, lineSpacing: 1.12,
    });
    addText(s, "TEAM NAME  ·  AUG 22, 2026", 68, 354, 500, 24, {
      size: 13, font: SANS, bold: true, color: C.muted,
    });
    const hero = await imageBytes(HERO);
    s.images.add({
      blob: hero, contentType: "image/png", alt: "A pale ribbon crossing a dry lake bed toward two metal frames",
      fit: "cover", position: { left: 0, top: 398, width: W, height: 322 }, name: "editorial-hero",
    });
    rect(s, 0, 672, W, 48, "#0A0A0ACC", "hero-caption-band");
    addText(s, "HACKATHON ENTRY TEMPLATE", 32, 686, 360, 18, {
      size: 12, font: SANS, bold: true, color: C.white,
    });
    addText(s, "REPLACE EVERY PLACEHOLDER BEFORE PRESENTING", 780, 686, 460, 18, {
      size: 11, font: SANS, color: "#D8D7D1", align: "right",
    });
    notes(s, "OpenAI ImageGen (generated editorial hero image)");
  }

  // 02 — Problem
  {
    const s = p.slides.add();
    s.background.fill = C.paper;
    topBar(s, 2, "Problem");
    addText(s, "CONTENTS", 64, 100, 170, 20, { size: 14, font: SANS, bold: true });
    addText(s, "Problem\nWho feels it\nWhy it persists\nWhat it costs", 64, 145, 150, 170, {
      size: 16, font: SERIF, color: C.muted, lineSpacing: 1.35,
    });
    rect(s, 238, 108, 1, 510, C.rule, "editorial-rule");
    eyebrow(s, "01 / Problem", 285, 98);
    addText(s, "The problem is visible.\nThe cost is compounding.", 285, 140, 900, 142, {
      name: "problem-title", size: 48, font: DISPLAY, color: C.ink, lineSpacing: 0.94,
    });
    addText(s, "Describe the user, the moment the workflow breaks, and why existing solutions still leave the hard part unresolved.", 285, 312, 780, 92, {
      size: 22, font: SERIF, color: C.ink, lineSpacing: 1.28,
    });
    addText(s, "XX%", 285, 452, 260, 96, { name: "primary-problem-metric", size: 72, font: DISPLAY });
    addText(s, "PRIMARY COST OR FAILURE RATE\nAdd the source and sample size in one line.", 570, 466, 560, 70, {
      size: 15, font: SANS, color: C.muted, lineSpacing: 1.2,
    });
    rect(s, 285, 580, 855, 2, C.accent, "accent-rule");
    addText(s, "The audience should feel the problem before they hear the feature list.", 285, 595, 850, 30, {
      size: 14, font: SANS, italic: true, color: C.muted,
    });
    notes(s);
  }

  // 03 — Insight
  {
    const s = p.slides.add();
    s.background.fill = C.paper;
    topBar(s, 3, "Insight");
    eyebrow(s, "02 / The insight");
    addText(s, "“The non-obvious thing\nwe learned goes here.”", 110, 185, 1060, 180, {
      name: "core-insight", size: 51, font: SERIF, color: C.ink, align: "center", lineSpacing: 1.03,
    });
    rect(s, 430, 420, 420, 2, C.accent, "accent-rule");
    addText(s, "Explain why this insight changes the design of the product—not merely how you describe it.", 270, 462, 740, 70, {
      size: 20, font: SANS, color: C.muted, align: "center", lineSpacing: 1.2,
    });
    addText(s, "EVIDENCE / OBSERVATION / USER QUOTE", 410, 590, 460, 22, {
      size: 12, font: SANS, bold: true, color: C.accent, align: "center",
    });
    notes(s);
  }

  // 04 — Solution
  {
    const s = p.slides.add();
    s.background.fill = C.ink;
    topBar(s, 4, "Solution", true);
    eyebrow(s, "03 / Solution", 64, 96, "#BDBBB4");
    addText(s, "A focused system that closes the loop.", 64, 140, 980, 72, {
      name: "solution-title", size: 46, font: DISPLAY, color: C.white,
    });
    addText(s, "Replace these three verbs with the core behavior of your product.", 66, 226, 700, 38, {
      size: 18, font: SERIF, color: "#D5D3CC",
    });
    const labels = [
      ["01", "OBSERVE", "What signal enters the system?"],
      ["02", "DECIDE", "What reasoning or model changes the outcome?"],
      ["03", "VERIFY", "How does the system know it worked?"],
    ];
    const xs = [70, 440, 810];
    rect(s, 130, 386, 850, 2, "#4B4B4B", "process-line");
    labels.forEach(([num, title, body], i) => {
      circle(s, xs[i], 350, 72, i === 1 ? C.accent : C.ink, C.white, 2);
      addText(s, num, xs[i], 371, 72, 26, { size: 17, font: SANS, bold: true, color: C.white, align: "center" });
      addText(s, title, xs[i] - 2, 452, 260, 36, { size: 26, font: DISPLAY, color: C.white });
      addText(s, body, xs[i] - 2, 500, 285, 70, { size: 17, font: SERIF, color: "#C9C7C0", lineSpacing: 1.2 });
    });
    addText(s, "ONE LINE ON THE DELIGHTFUL DIFFERENCE", 70, 642, 880, 22, {
      size: 13, font: SANS, bold: true, color: C.accent,
    });
    notes(s);
  }

  // 05 — Demo
  {
    const s = p.slides.add();
    s.background.fill = C.paper;
    topBar(s, 5, "Demo");
    eyebrow(s, "04 / Product demo");
    addText(s, "Show the product doing the hard part.", 64, 132, 930, 62, {
      name: "demo-title", size: 43, font: DISPLAY,
    });
    rect(s, 64, 220, 1152, 386, C.fog, "product-demo-placeholder", C.ink, 1);
    addText(s, "DROP PRODUCT DEMO\nOR SCREENSHOT HERE", 340, 346, 600, 92, {
      size: 31, font: DISPLAY, color: C.white, align: "center", lineSpacing: 1.0,
    });
    addText(s, "01", 84, 242, 50, 20, { size: 13, font: SANS, bold: true, color: C.white });
    addText(s, "Caption the moment judges should notice. Keep it specific.", 64, 628, 840, 28, {
      size: 16, font: SERIF, color: C.muted,
    });
    addText(s, "LIVE DEMO →", 1020, 628, 196, 24, { size: 13, font: SANS, bold: true, color: C.accent, align: "right" });
    notes(s);
  }

  // 06 — Architecture
  {
    const s = p.slides.add();
    s.background.fill = C.paper;
    topBar(s, 6, "Architecture");
    eyebrow(s, "05 / System");
    addText(s, "The architecture protects\nthe product promise.", 64, 136, 560, 116, {
      name: "architecture-title", size: 42, font: DISPLAY, lineSpacing: 0.94,
    });
    addText(s, "Name the one technical choice that makes the demo credible: persistence, verification, latency, data access, or safety.", 66, 280, 460, 118, {
      size: 21, font: SERIF, color: C.ink, lineSpacing: 1.28,
    });
    addText(s, "TECHNICAL EDGE", 66, 455, 180, 20, { size: 12, font: SANS, bold: true, color: C.accent });
    addText(s, "One concise sentence on what is genuinely hard to reproduce.", 66, 488, 430, 72, {
      size: 17, font: SANS, color: C.muted, lineSpacing: 1.2,
    });
    const boxX = 690;
    const boxW = 450;
    const items = [
      ["INPUT", "Trigger, context, or user intent"],
      ["AGENT LOOP", "Plan → tool use → checkpoint"],
      ["VERIFIER", "Environment state or metric"],
      ["OUTCOME", "Action the user can trust"],
    ];
    items.forEach(([title, body], i) => {
      const y = 125 + i * 128;
      if (i < items.length - 1) rect(s, boxX + 34, y + 86, 2, 42, C.ink, `connector-${i + 1}`);
      circle(s, boxX, y + 24, 70, i === 2 ? C.accent : C.paper, C.ink, 2);
      addText(s, String(i + 1).padStart(2, "0"), boxX, y + 47, 70, 22, {
        size: 15, font: SANS, bold: true, color: i === 2 ? C.white : C.ink, align: "center",
      });
      addText(s, title, boxX + 100, y + 18, boxW - 100, 28, { size: 21, font: DISPLAY, bold: false });
      addText(s, body, boxX + 100, y + 54, boxW - 100, 38, { size: 16, font: SERIF, color: C.muted });
      rect(s, boxX + 100, y + 100, boxW - 100, 1, C.rule, `rule-${i + 1}`);
    });
    notes(s);
  }

  // 07 — Evidence
  {
    const s = p.slides.add();
    s.background.fill = C.paper;
    topBar(s, 7, "Evidence");
    eyebrow(s, "06 / Measurement");
    addText(s, "A credible win in one honest measurement.", 64, 135, 1000, 68, {
      name: "evidence-title", size: 46, font: DISPLAY,
    });
    addText(s, "PRIMARY METRIC", 66, 260, 240, 22, { size: 13, font: SANS, bold: true, color: C.accent });
    addText(s, "XX%", 64, 300, 360, 120, { name: "primary-success-metric", size: 88, font: DISPLAY });
    addText(s, "Describe what changed, compared with what baseline, over what sample.", 66, 438, 420, 92, {
      size: 20, font: SERIF, color: C.ink, lineSpacing: 1.24,
    });
    rect(s, 540, 252, 1, 330, C.rule, "metric-divider");
    const metrics = [
      ["XX×", "FASTER", "Time-to-result versus baseline"],
      ["XX", "RUNS", "State the sample size"],
      ["XX%", "SUCCESS", "Define success precisely"],
    ];
    metrics.forEach(([value, label, body], i) => {
      const y = 250 + i * 112;
      addText(s, value, 610, y, 190, 54, { size: 42, font: DISPLAY });
      addText(s, label, 820, y + 4, 190, 22, { size: 13, font: SANS, bold: true, color: C.accent });
      addText(s, body, 820, y + 34, 350, 35, { size: 16, font: SERIF, color: C.muted });
      if (i < 2) rect(s, 610, y + 90, 540, 1, C.rule, `metric-rule-${i + 1}`);
    });
    addText(s, "REPLACE ALL SAMPLE VALUES · CITE THE SOURCE", 610, 590, 540, 22, {
      size: 12, font: SANS, bold: true, color: C.muted,
    });
    notes(s);
  }

  // 08 — Why now / differentiation
  {
    const s = p.slides.add();
    s.background.fill = C.paper;
    topBar(s, 8, "Why now");
    eyebrow(s, "07 / Why this wins");
    addText(s, "Why this idea matters now.", 64, 136, 780, 68, {
      name: "why-now-title", size: 47, font: DISPLAY,
    });
    const reasons = [
      ["01", "A capability shift", "Name the model, platform, or behavior that only recently became possible."],
      ["02", "A distribution advantage", "Explain how this reaches users faster than a technically similar product."],
      ["03", "A compounding moat", "Identify the data, workflow, or feedback loop that improves with every use."],
    ];
    reasons.forEach(([num, title, body], i) => {
      const y = 270 + i * 120;
      addText(s, num, 64, y, 80, 30, { size: 16, font: SANS, bold: true, color: C.accent });
      addText(s, title, 180, y - 4, 360, 38, { size: 27, font: DISPLAY });
      addText(s, body, 570, y, 590, 54, { size: 18, font: SERIF, color: C.muted, lineSpacing: 1.18 });
      rect(s, 64, y + 78, 1096, 1, C.rule, `reason-rule-${i + 1}`);
    });
    notes(s);
  }

  // 09 — Team and ask
  {
    const s = p.slides.add();
    s.background.fill = C.ink;
    topBar(s, 9, "Team + next step", true);
    eyebrow(s, "08 / Close", 64, 96, "#BDBBB4");
    addText(s, "The team can ship\nthe next version.", 64, 140, 780, 150, {
      name: "closing-title", size: 53, font: DISPLAY, color: C.white, lineSpacing: 0.92,
    });
    addText(s, "NAME / ROLE", 68, 350, 300, 28, { size: 18, font: SANS, bold: true, color: C.white });
    addText(s, "One line of unusually relevant experience.", 68, 392, 330, 50, { size: 17, font: SERIF, color: "#BDBBB4" });
    addText(s, "NAME / ROLE", 456, 350, 300, 28, { size: 18, font: SANS, bold: true, color: C.white });
    addText(s, "One line of unusually relevant experience.", 456, 392, 330, 50, { size: 17, font: SERIF, color: "#BDBBB4" });
    addText(s, "NAME / ROLE", 844, 350, 300, 28, { size: 18, font: SANS, bold: true, color: C.white });
    addText(s, "One line of unusually relevant experience.", 844, 392, 330, 50, { size: 17, font: SERIF, color: "#BDBBB4" });
    rect(s, 64, 494, 1096, 2, C.accent, "closing-rule");
    addText(s, "WHAT WE NEED NEXT", 64, 535, 280, 22, { size: 13, font: SANS, bold: true, color: C.accent });
    addText(s, "A pilot partner, a technical collaborator, or one concrete decision.", 64, 572, 770, 60, {
      size: 24, font: SERIF, color: C.white,
    });
    addText(s, "DEMO URL / QR", 920, 574, 240, 24, { size: 14, font: SANS, bold: true, color: C.white, align: "right" });
    addText(s, "Make the final request easy to answer.", 920, 610, 240, 34, { size: 14, font: SERIF, color: "#BDBBB4", align: "right" });
    notes(s);
  }

  for (const [i, slide] of p.slides.items.entries()) {
    const png = await p.export({ slide, format: "png", scale: 1 });
    await fs.writeFile(`${PREVIEW_DIR}/slide-${String(i + 1).padStart(2, "0")}.png`, new Uint8Array(await png.arrayBuffer()));
    const layout = await slide.export({ format: "layout" });
    await fs.writeFile(`${PREVIEW_DIR}/slide-${String(i + 1).padStart(2, "0")}.layout.json`, await layout.text());
  }
  const montage = await p.export({ format: "webp", montage: true, scale: 1 });
  await fs.writeFile(`${PREVIEW_DIR}/montage.webp`, new Uint8Array(await montage.arrayBuffer()));
  const pptx = await PresentationFile.exportPptx(p);
  await pptx.save(OUT);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
