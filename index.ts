import { generateText, stepCountIs, tool, type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import blessed from 'neo-blessed';
import figlet from 'figlet';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import 'dotenv/config';

const openrouterApiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!openrouterApiKey) {
  console.error(
    'Missing OPENROUTER_API_KEY. Add it to .env or export it before starting Goalie.',
  );
  process.exit(1);
}

const openrouterModel =
  process.env.OPENROUTER_MODEL?.trim() ||
  'nvidia/nemotron-3-ultra-550b-a55b:free';
const openrouterHeaders: Record<string, string> = {
  'X-OpenRouter-Title':
    process.env.OPENROUTER_TITLE?.trim() || 'Goalie CLI',
};
const openrouterSiteUrl = process.env.OPENROUTER_SITE_URL?.trim();
if (openrouterSiteUrl) {
  openrouterHeaders['HTTP-Referer'] = openrouterSiteUrl;
}

// OpenRouter exposes an OpenAI-compatible Chat Completions API.
const openrouter = createOpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: openrouterApiKey,
  headers: openrouterHeaders,
});

// 2. Initialize the Blessed Screen Interface
const screen = blessed.screen({
  smartCSR: true,
  title: 'Goalie CLI',
});

// 3. Create the Main Log / History Window
const logBox = blessed.box({
  top: 0,
  left: 0,
  width: '100%',
  height: '90%',
  content: '{bold}{cyan-fg}🤖 Goalie CLI Initialized...{/}\n\n',
  tags: true,
  border: { type: 'line' },
  style: {
    border: { fg: '#f0f0f0' },
  },
  scrollable: true,
  alwaysScroll: true,
  scrollbar: {
    ch: ' ',
    style: { bg: 'cyan' }
  }
});

// 4. Create the Bottom Input Field
const inputField = blessed.textbox({
  bottom: 0,
  left: 0,
  width: '100%',
  height: '10%',
  keys: true,
  mouse: true,
  inputOnFocus: true,
  border: { type: 'line' },
  style: {
    fg: 'white',
    border: { fg: 'green' },
    focus: { border: { fg: 'cyan' } }
  }
});

// Append visual components to screen container
screen.append(logBox);
screen.append(inputField);
inputField.focus();

// Global chat history state
const instructions =
  'You are a terminal coding assistant. Keep text concise.';
const messages: ModelMessage[] = [];

// Helper function to append text directly to the TUI display log
function appendLog(text: string) {
  logBox.pushLine(text);
  logBox.setScrollPerc(100); // Always auto-scroll to the absolute bottom
  screen.render();
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function handleInput(userInput: string) {
  if (!userInput.trim()) return;

  // 1. Temporarily save the current logs content so we don't lose the chat history
  const historicalContent = logBox.getContent();

  // 2. Generate the static large ASCII text structure
  const asciiBanner = figlet.textSync('STARTING', {
    font: 'Standard',
    horizontalLayout: 'default',
  });

  // 3. Define the visual color frames for the animation loop
  // Blessed tags allow easy hex or basic terminal color styling
  const colorFrames = [
    `{8-fg}${asciiBanner}{/}`,       // Dark Gray (Frame 1)
    `{yellow-fg}${asciiBanner}{/}`,  // Dim Yellow (Frame 2)
    `{green-fg}${asciiBanner}{/}`,   // Bright Green (Frame 3)
    `{cyan-fg}${asciiBanner}{/}`,    // Cyber Cyan (Frame 4)
    `{white-fg}${asciiBanner}{/}`    // Flash White (Frame 5)
  ];

  // 4. Run the frame-by-frame animation loop (Takes 500ms total)
  for (const frameContent of colorFrames) {
    logBox.setContent(frameContent);
    screen.render();
    await delay(250); // 100ms per frame * 5 frames = 500ms delay
  }

  // 5. RESTORE the conversation history and append the new task traces
  logBox.setContent(historicalContent);
  appendLog(`{bold}{green-fg}User >{/} ${userInput}`);
  messages.push({ role: 'user', content: userInput });
  
  appendLog('{yellow-fg}System > AI is thinking...{/}');
  screen.render();

  // 6. Send the request through OpenRouter's Chat Completions-compatible model.
  try {
    const response = await generateText({
      model: openrouter.chat(openrouterModel),
      instructions,
      messages: messages,
      stopWhen: stepCountIs(5),
      tools: {
        writeFile: tool({
          description: 'Write or update a local workspace file',
          inputSchema: z.object({
            path: z.string().min(1),
            content: z.string(),
          }),
          execute: async ({ path, content }) => {
            appendLog(`{magenta-fg}[Tool Executing: Writing to ${path}]{/}`);
            await writeFile(path, content, 'utf-8');
            return { status: 'Success' };
          },
        }),
      },
    });

    if (response.text) {
      appendLog(`{bold}{cyan-fg}Agent >{/} ${response.text}\n`);
    }

    // Keep assistant tool calls/results as well as plain text in the next turn.
    messages.push(...response.responseMessages);
  } catch (err: any) {
    appendLog(`{red-fg}Error: ${err.message}{/}`);
  }

  // Clear input box and return focus
  inputField.setValue('');
  inputField.focus();
  screen.render();
}

// 6. Hook up Keyboard Event Handlers
inputField.on('submit', (text: string) => {
  void handleInput(text);
});

// Global escape hatch keys to exit application instantly
screen.key(['escape', 'q', 'C-c'], () => {
  return process.exit(0);
});

// First initial screen render
screen.render();
