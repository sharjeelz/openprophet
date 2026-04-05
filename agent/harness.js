// Prophet Agent Harness - Autonomous trading agent with phased heartbeat
// Uses claude CLI subprocess for auth (OAuth/API key handled by CLI)
import { spawn, execSync } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';

// On Windows, npm CLI tools are .cmd files that require shell:true to spawn
const OPENCODE_BIN = 'opencode';
const OPENCODE_SHELL = process.platform === 'win32';

// ── Telegram Notifications ─────────────────────────────────────────
async function sendSaudiTelegramSignal(symbol, action, thesis, price) {
  const priceStr = price ? `\nPrice: SAR ${price}` : '';
  const text = `🇸🇦 <b>SAUDI SIGNAL</b>\n\n<b>${action}</b> ${symbol}${priceStr}\n\n<b>Thesis:</b> ${thesis}\n\n<i>RESEARCH ONLY — No execution</i>`;
  await sendTelegramSignal(text);
}

async function sendTelegramSignal(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const { default: https } = await import('https');
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    await new Promise((resolve, reject) => {
      const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.error('[telegram] Failed to send signal:', err.message);
  }
}

// Default max tool rounds; overridden by permissions config at runtime

// ── Phase Configuration ────────────────────────────────────────────
export const PHASE_DEFAULTS = {
  pre_market:   { seconds: 900,  label: 'Pre-Market',    range: [240, 570]  },
  market_open:  { seconds: 120,  label: 'Market Open',   range: [570, 630]  },
  midday:       { seconds: 600,  label: 'Midday',        range: [630, 900]  },
  market_close: { seconds: 120,  label: 'Market Close',  range: [900, 960]  },
  after_hours:  { seconds: 1800, label: 'After Hours',   range: [960, 1200] },
  closed:       { seconds: 3600, label: 'Markets Closed', range: null },
};

export function getCurrentPhase() {
  const now = new Date();
  const et = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = et.split(':').map(Number);
  const mins = h * 60 + m;
  const weekday = now.getDay() >= 1 && now.getDay() <= 5;
  if (!weekday) return 'closed';
  for (const [phase, cfg] of Object.entries(PHASE_DEFAULTS)) {
    if (cfg.range && mins >= cfg.range[0] && mins < cfg.range[1]) return phase;
  }
  return 'closed';
}

// Saudi market phase detection (Tadawul: Sun–Thu, 10:00–15:00 AST = 07:00–12:00 UTC)
export function getSaudiPhase() {
  const now = new Date();
  // Get both time and weekday in Riyadh timezone
  const riyadhDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' }));
  const h = riyadhDate.getHours();
  const m = riyadhDate.getMinutes();
  const day = riyadhDate.getDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  const mins = h * 60 + m;
  if (day === 5 || day === 6) return 'saudi_closed'; // Fri/Sat
  if (mins >= 570 && mins < 600) return 'saudi_pre_market'; // 9:30–10:00 AST
  if (mins >= 600 && mins < 900) return 'saudi_open';       // 10:00–15:00 AST
  return 'saudi_closed';
}

// ── System Prompt Builder ──────────────────────────────────────────
export async function buildSystemPrompt(agentConfig, options = {}) {
  if (!agentConfig) agentConfig = {};
  const { getStrategyById = () => null } = options;
  let strategyRules = '';
  if (agentConfig.customStrategyRules) {
    strategyRules = agentConfig.customStrategyRules;
  } else if (agentConfig.strategyId) {
    const strategy = getStrategyById(agentConfig.strategyId);
    if (strategy) {
      if (strategy.rulesFile) {
        try { strategyRules = await fs.readFile(path.join(process.cwd(), strategy.rulesFile), 'utf-8'); } catch (err) { console.error(`Warning: Failed to load strategy rules file "${strategy.rulesFile}":`, err.message); }
      } else if (strategy.customRules) {
        strategyRules = strategy.customRules;
      }
    }
  }

  // Build trading rules from strategy
  let tradingRules = strategyRules;
  if (!tradingRules) {
    try { tradingRules = await fs.readFile(path.join(process.cwd(), 'TRADING_RULES.md'), 'utf-8'); } catch (err) { tradingRules = ''; }
  }

  // Layer 1: Agent Identity (custom or default)
  const identity = (agentConfig.systemPromptTemplate === 'custom' && agentConfig.customSystemPrompt)
    ? agentConfig.customSystemPrompt
    : `You are ${agentConfig.name || 'Prophet'}, an autonomous AI trading agent. You run on a heartbeat loop — each time you wake up, you assess the market, manage positions, and decide what to do.\n\n${agentConfig.description || 'You are a disciplined trading agent'}\n\nYou are running autonomously — no human is approving your actions in real-time.`;

  // Layer 2: Strategy Rules
  const rulesBlock = tradingRules
    ? `## Strategy Rules\nThese are the hard rules you MUST follow. They define what you can trade, position sizes, risk limits, and exit criteria.\n\n${tradingRules}`
    : '## No Strategy Rules Assigned\nNo trading rules have been configured. Use conservative defaults: max 10% per position, always use limit orders, maintain 50%+ cash.';

  // Layer 3: System Instructions (tools, heartbeat, operational)
  const systemInstructions = `## Available Tools

**Trading**: get_account, get_positions, get_orders, place_buy_order, place_sell_order, place_managed_position, get_managed_positions, close_managed_position, cancel_order
**Options**: place_options_order, get_options_positions, get_options_position, get_options_chain
**Market Data**: get_quote, get_latest_bar, get_historical_bars, analyze_stocks
**News**: get_news, search_news, get_market_news, get_quick_market_intelligence, get_cleaned_news, get_marketwatch_topstories
**Saudi Research**: get_saudi_news, get_saudi_market_intelligence (use when Tadawul is open: Sun–Thu 10:00–15:00 AST)
**Agent Config**: update_agent_prompt, update_strategy_rules, get_agent_config, set_heartbeat, update_permissions, set_session_mode, create_agent, create_strategy, assign_agent_to_sandbox
**Heartbeat**: get_heartbeat_profiles, apply_heartbeat_profile, get_heartbeat_phases, update_heartbeat_phase
**Logging**: log_decision, log_activity, get_activity_log
**Trade History**: find_similar_setups, store_trade_setup, get_trade_stats
**Utility**: get_datetime, wait

## Heartbeat Behavior

Each heartbeat you should:
1. Check time and market status
2. Review account and positions
3. Decide and act based on phase:
   - Pre-market: Gather intelligence, plan
   - Market open: Execute, monitor
   - Midday: Monitor positions, check stops
   - Market close: Review, decide holds
   - After hours: Review, log activity
4. Follow your strategy rules
5. Summarize what you did

Heartbeat control:
- apply_heartbeat_profile: "active" | "passive" | "long_horizon" | "earnings_season" | "overnight" | "scalp"
- set_heartbeat: override interval in seconds
- Phases (ET): pre_market 4-9:30am, market_open 9:30-10:30am, midday 10:30am-3pm, market_close 3-4pm, after_hours 4-8pm

## Operational Rules
- Be decisive. Analyze and act.
- Always narrate what you are doing as you do it — before each tool call, write 1 line explaining what you're checking and why.
- After each key finding (news, quote, chain), write a brief observation so the operator can follow your reasoning.
- Always end each beat with a plain-English summary: what you checked, what you found, what you did or decided, and what to watch next.
- Always log trade reasoning with log_decision.
- NEVER ask the user questions. You are autonomous.
- If you need information, use your tools.
- If nothing to trade, explain why (no setup, waiting for confirmation, etc.) — never just go silent.`;

  return `${identity}\n\n${rulesBlock}\n\n${systemInstructions}`;
}

// ── Check CLI auth ─────────────────────────────────────────────────
export function checkCliAuth() {
  // API key in env takes precedence — OpenCode picks it up automatically
  if (process.env.ANTHROPIC_API_KEY) return true;
  try {
    const out = execSync('opencode auth list 2>&1', { timeout: 5000, encoding: 'utf-8' });
    // Accept any valid credential (Anthropic, OpenCode Zen, OpenAI, etc.)
    return out.includes('credential') || out.includes('oauth') || out.includes('api') || out.includes('Anthropic');
  } catch {
    return false;
  }
}

// ── Agent State ────────────────────────────────────────────────────
export class AgentState extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.paused = false;
    this.phase = 'closed';
    this.heartbeatSeconds = 120;
    this.heartbeatOverride = null;
    this.beatCount = 0;
    this.lastBeatTime = null;
    this.nextBeatTime = null;
    this.activeAgentId = null;
    this.activeAccountId = null;
    this.activeModel = null;
    this.recentTrades = [];
    this.stats = {
      totalBeats: 0,
      toolCalls: 0,
      trades: 0,
      errors: 0,
      startedAt: null,
    };
  }

  addTrade(trade) {
    this.recentTrades.unshift({ ...trade, timestamp: new Date().toISOString() });
    if (this.recentTrades.length > 50) this.recentTrades.pop();
    this.emit('trade', trade);
  }

  toJSON() {
    return {
      running: this.running,
      paused: this.paused,
      phase: this.phase,
      phaseLabel: PHASE_DEFAULTS[this.phase]?.label || 'Unknown',
      heartbeatSeconds: this.heartbeatSeconds,
      heartbeatOverride: this.heartbeatOverride,
      beatCount: this.beatCount,
      lastBeatTime: this.lastBeatTime,
      nextBeatTime: this.nextBeatTime,
      activeAgentId: this.activeAgentId,
      activeAccountId: this.activeAccountId,
      activeModel: this.activeModel,
      recentTrades: this.recentTrades.slice(0, 10),
      stats: this.stats,
    };
  }
}

// ── Agent Harness (CLI subprocess) ─────────────────────────────────
export class AgentHarness {
  constructor(options = {}) {
    const {
      sandboxId = null,
      accountId = null,
      getSandbox = () => null,
      getAccount = () => null,
      getAgent = () => null,
      getResolvedAgent = null,
      getStrategyById = () => null,
      getHeartbeatForPhase = () => null,
      getPermissions = () => ({}),
      chatStore = null,
      opencodeEnv = {},
      checkCliAuthFn = checkCliAuth,
      getCurrentPhaseFn = getCurrentPhase,
    } = options;

    this.state = new AgentState();
    this.sandboxId = sandboxId;
    this.accountId = accountId;
    this.getSandbox = getSandbox;
    this.getAccount = getAccount;
    this.getAgent = getAgent;
    this.getResolvedAgent = getResolvedAgent;
    this.getStrategyById = getStrategyById;
    this.getHeartbeatForPhase = getHeartbeatForPhase;
    this.getPermissions = getPermissions;
    this.chatStore = chatStore;
    this.opencodeEnv = opencodeEnv;
    this.checkCliAuthFn = checkCliAuthFn;
    this.getCurrentPhaseFn = getCurrentPhaseFn;
    this.systemPrompt = '';
    this._timer = null;
    this._beating = false;
    this._agentConfig = null;
    this._sandboxConfig = null;
    this._sessionId = null; // persist session across beats for context
    this._proc = null;       // current opencode subprocess
    this._pendingMessages = [];
    this._interrupted = false;
    this._beatTimeout = null;
    this._sessionEpoch = 0;
  }

  _resolveSandbox() {
    return this.getSandbox(this.sandboxId);
  }

  _resolveAccount() {
    const sandbox = this._resolveSandbox();
    return this.getAccount(this.accountId || sandbox?.accountId || null);
  }

  _resolveAgent() {
    if (this.getResolvedAgent) {
      return this.getResolvedAgent(this.sandboxId);
    }
    const sandbox = this._resolveSandbox();
    const agentId = sandbox?.agent?.activeAgentId || null;
    return agentId ? this.getAgent(agentId) : null;
  }

  _resolvePermissions() {
    return this.getPermissions(this.sandboxId) || {};
  }

  async _persistSession(sessionId, metadata = {}) {
    if (!this.chatStore || !sessionId || !this.state.activeAccountId) return;
    await this.chatStore.startSession(this.state.activeAccountId, sessionId, {
      sandboxId: this.sandboxId,
      accountId: this.state.activeAccountId,
      agentId: this.state.activeAgentId,
      agentName: this._agentConfig?.name,
      model: this.state.activeModel,
      ...metadata,
    });
  }

  async _persistMessages(sessionId, messages = []) {
    if (!this.chatStore || !sessionId || !this.state.activeAccountId) return;
    for (const message of messages) {
      if (!message?.content?.trim()) continue;
      await this.chatStore.addMessage(this.state.activeAccountId, sessionId, message);
    }
  }

  async start() {
    if (this.state.running) return;

    // Check CLI auth
    if (!this.checkCliAuthFn()) {
      throw new Error('OpenCode not authenticated. Run "opencode auth login" or set ANTHROPIC_API_KEY in .env');
    }

    await this.reloadConfig({ resetSession: true, silent: true });

    this.state.running = true;
    this.state.paused = false;
    this.state.stats = { totalBeats: 0, toolCalls: 0, trades: 0, errors: 0, startedAt: new Date().toISOString() };
    this.state.beatCount = 0;
    this.state.recentTrades = [];
    this._sessionId = null;

    const account = this._resolveAccount();
    const model = this.state.activeModel;
    this.state.emit('status', { status: 'started', sandboxId: this.sandboxId, agent: this._agentConfig.name, model, account: account?.name });
    this.state.emit('agent_log', {
      message: `Agent "${this._agentConfig.name}" started on ${model}${account ? ` | Account: ${account.name}` : ''}${this.sandboxId ? ` | Sandbox: ${this.sandboxId}` : ''}`,
      level: 'success',
    });

    await this._beat();
    this._scheduleNext();
  }

  async reloadConfig(options = {}) {
    const { resetSession = true, silent = false } = options;

    this._sandboxConfig = this._resolveSandbox();
    if (!this._sandboxConfig) throw new Error(`Sandbox not found: ${this.sandboxId || 'unknown'}`);

    this._agentConfig = this._resolveAgent();
    if (!this._agentConfig) throw new Error(`Agent not found for sandbox ${this._sandboxConfig.id}`);

    const account = this._resolveAccount();
    const model = this._agentConfig.model || this._sandboxConfig.agent?.model || 'anthropic/claude-sonnet-4-6';

    this.state.activeAgentId = this._agentConfig.id;
    this.state.activeAccountId = account?.id || this._sandboxConfig.accountId || null;
    this.state.activeModel = model;
    this.systemPrompt = await buildSystemPrompt(this._agentConfig, {
      getStrategyById: this.getStrategyById,
    });

    if (resetSession) {
      this._sessionId = null;
      this._sessionEpoch += 1;
    }
    if (!silent) {
      this.state.emit('agent_log', {
        message: `Sandbox config reloaded for ${this.sandboxId}. Prompt changes apply on the next beat.`,
        level: 'info',
      });
    }
  }

  async stop() {
    this.state.running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._beatTimeout) { clearTimeout(this._beatTimeout); this._beatTimeout = null; }
    this._sessionEpoch += 1;
    this._sessionId = null;

    const procToKill = this._proc;
    if (procToKill && !procToKill.killed) {
      procToKill.kill('SIGTERM');
      setTimeout(() => {
        if (!procToKill.killed) procToKill.kill('SIGKILL');
      }, 2000);
    }

    await new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        if (!this._beating && (!procToKill || procToKill.killed || this._proc !== procToKill)) return resolve();
        if (Date.now() - started > 5000) return resolve();
        setTimeout(check, 100);
      };
      check();
    });

    this.state.emit('status', { status: 'stopped' });
    this.state.emit('agent_log', { message: 'Agent stopped.', level: 'warning' });
  }

  pause() {
    this.state.paused = true;
    this.state.emit('status', { status: 'paused' });
    this.state.emit('agent_log', { message: 'Agent paused.', level: 'warning' });
  }

  resume() {
    this.state.paused = false;
    this.state.emit('status', { status: 'resumed' });
    this.state.emit('agent_log', { message: 'Agent resumed.', level: 'success' });
  }

  /**
   * Send a user message to the agent.
   * - If idle: triggers an immediate ad-hoc beat with the message.
   * - If busy: interrupts the current beat (kills the opencode process),
   *   then resumes the SAME session with the user's message so context is preserved.
   */
  async sendMessage(message) {
    if (!this.state.running) {
      throw new Error('Agent is not running. Start the agent first.');
    }

    const trimmed = message.trim();
    
    // Handle slash commands locally
    if (trimmed.startsWith('/')) {
      const cmd = trimmed.split(' ')[0].toLowerCase();
      const parts = trimmed.split(' ');
      
      if (cmd === '/help' || cmd === '/?') {
        this.state.emit('agent_log', { message: 'Available commands:\n/newagent - Create new agent\n/editagent <id> - Edit agent\n/agents - List agents\n/sandboxes - List portfolios\n/status - Portfolio status\n/portfolios - Portfolio status', level: 'info' });
        return { sent: true };
      }
      
      if (cmd === '/agents') {
        const agents = this._agentConfig ? [this._agentConfig] : [];
        this.state.emit('agent_log', { message: 'Agents: ' + agents.map(a => a.name || a.id).join(', ') + '\nUse /editagent <id> to edit', level: 'info' });
        return { sent: true };
      }
      
      if (cmd === '/newagent') {
        this.state.emit('agent_log', { message: 'Opening agent builder... Type /help for other commands.', level: 'info' });
        return { sent: true };
      }
    }

    this.state.emit('agent_log', {
      message: `User: ${message}`,
      level: 'info',
    });

    if (this._beating) {
      // Interrupt the current beat
      this.state.emit('agent_log', {
        message: 'Interrupting current beat to handle user message...',
        level: 'warning',
      });

      this._interrupted = true;

      // Kill the running opencode subprocess — capture ref so the
      // SIGKILL fallback targets THIS process, not a future one.
      const procToKill = this._proc;
      if (procToKill && !procToKill.killed) {
        procToKill.kill('SIGTERM');
        setTimeout(() => {
          if (!procToKill.killed) {
            procToKill.kill('SIGKILL');
          }
        }, 2000);
      }

      // Fire the follow-up beat asynchronously (don't await — return immediately)
      this._interruptAndResume(message);
      return { interrupted: true, sent: true };
    }

    // Not busy — cancel the scheduled next beat and run immediately
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }

    // Also fire async so the HTTP response returns fast
    this._fireAdHocBeat(message);
    return { sent: true };
  }

  /** Wait for current beat to die, then run ad-hoc beat with user message */
  async _interruptAndResume(message) {
    // Wait for the current beat to finish its cleanup
    await new Promise((resolve) => {
      const check = () => {
        if (!this._beating) return resolve();
        setTimeout(check, 100);
      };
      check();
    });

    if (!this.state.running) return;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    await this._adHocBeat(message);
    this._scheduleNext();
  }

  /** Cancel scheduled beat and fire an ad-hoc beat, then reschedule */
  async _fireAdHocBeat(message) {
    if (!this.state.running) return;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    await this._adHocBeat(message);
    this._scheduleNext();
  }

  async _adHocBeat(userMessage) {
    if (!this.state.running) return;
    if (this._beating) return;
    this._beating = true;

    const beatNum = ++this.state.beatCount;
    this.state.stats.totalBeats = beatNum;
    this.state.lastBeatTime = new Date().toISOString();
    const phase = this.getCurrentPhaseFn();
    this.state.phase = phase;
    const model = this.state.activeModel;

    // Drain any queued messages
    const queued = this._pendingMessages || [];
    this._pendingMessages = [];
    const allMessages = [userMessage, ...queued].filter(Boolean);
    const userBlock = allMessages.map(m => `USER MESSAGE: ${m}`).join('\n');

    this._isMessageBeat = true;
    this.state.emit('beat_start', { beat: beatNum, phase, time: this.state.lastBeatTime, isMessage: true });

    const prompt = `[MESSAGE BEAT #${beatNum}] Phase: ${PHASE_DEFAULTS[phase].label}. Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET.

The user/operator is sending you a direct message. Read it carefully and respond with a complete answer. You MUST respond with useful output - never just ask questions back without providing value first.

## Your Available Tools (DO NOT call get_agent_config to discover these)

**Trading**: get_account, get_positions, get_orders, place_buy_order, place_sell_order, place_managed_position, get_managed_positions, close_managed_position, cancel_order
**Options**: place_options_order, get_options_positions, get_options_position, get_options_chain
**Market Data**: get_quote, get_latest_bar, get_historical_bars, analyze_stocks
**News**: get_news, search_news, get_market_news, get_quick_market_intelligence, get_cleaned_news, get_marketwatch_topstories
**Saudi Research**: get_saudi_news, get_saudi_market_intelligence (use when Tadawul is open: Sun–Thu 10:00–15:00 AST), get_marketwatch_realtime
**Intelligence**: aggregate_and_summarize_news, list_news_summaries, get_news_summary
**Agent Config**: update_agent_prompt, update_strategy_rules, get_agent_config, set_heartbeat, update_permissions, set_session_mode, create_agent, create_strategy, assign_agent_to_sandbox
**Heartbeat**: get_heartbeat_profiles, apply_heartbeat_profile, get_heartbeat_phases, update_heartbeat_phase
**Logging**: log_decision, log_activity, get_activity_log
**Trade History**: find_similar_setups, store_trade_setup, get_trade_stats
**Utility**: get_datetime, wait

## Instructions
- If the user asks to create a new agent: use create_agent to create it, then optionally create_strategy for its rules, then assign_agent_to_sandbox to activate it.
- If the user asks to update the current agent: use update_agent_prompt and update_strategy_rules.
- If the user asks about trading, use your trading/market data tools.
- Always respond with concrete actions and details. Never ask what tools you have - they are listed above.

${userBlock}`;

    try {
      const result = await this._runClaude(prompt, model);
      if (result.error) throw new Error(result.error);
      // Text already streamed via _handleOpenCodeEvent agent_text events
      if (result.toolCalls) this.state.stats.toolCalls += result.toolCalls;
      const effectiveSessionId = result.sessionEpoch === this._sessionEpoch ? result.sessionId : null;
      if (effectiveSessionId) this._sessionId = effectiveSessionId;
      await this._persistSession(effectiveSessionId, { mode: 'message' });
      await this._persistMessages(effectiveSessionId, [
        ...allMessages.map(content => ({ role: 'user', kind: 'message', beat: beatNum, content })),
        { role: 'assistant', kind: 'message', beat: beatNum, toolCalls: result.toolCalls || 0, content: result.text || '' },
      ]);
    } catch (err) {
      this.state.stats.errors++;
      this.state.emit('agent_log', { message: `Message beat error: ${err.message}`, level: 'error' });
    }

    this.state.emit('beat_end', { beat: beatNum, phase, isMessage: true });
    this._isMessageBeat = false;
    this._beating = false;
  }

  _getHeartbeatSeconds() {
    if (this.state.heartbeatOverride) {
      const override = this.state.heartbeatOverride;
      if (override.oneTime) this.state.heartbeatOverride = null;
      return override.seconds;
    }
    const phase = this.getCurrentPhaseFn();
    this.state.phase = phase;
    // Agent-level overrides take priority, then global config, then hardcoded defaults
    if (this._agentConfig?.heartbeatOverrides?.[phase]) {
      return this._agentConfig.heartbeatOverrides[phase];
    }
    return this.getHeartbeatForPhase(this.sandboxId, phase) || PHASE_DEFAULTS[phase]?.seconds || 600;
  }

  _scheduleNext() {
    if (!this.state.running) return;
    // Always clear any existing timer first to prevent dual timers
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const seconds = this._getHeartbeatSeconds();
    this.state.heartbeatSeconds = seconds;
    this.state.nextBeatTime = new Date(Date.now() + seconds * 1000).toISOString();
    this.state.emit('schedule', { seconds, nextBeat: this.state.nextBeatTime, phase: this.state.phase });

    this._timer = setTimeout(async () => {
      if (!this.state.running) return;
      if (this.state.paused) {
        this.state.emit('agent_log', { message: 'Beat skipped (paused)', level: 'info' });
        this._scheduleNext();
        return;
      }
      await this._beat();
      this._scheduleNext();
    }, seconds * 1000);
  }

  async _beat() {
    if (this._beating) return;
    this._beating = true;

    const beatNum = ++this.state.beatCount;
    this.state.stats.totalBeats = beatNum;
    this.state.lastBeatTime = new Date().toISOString();
    const phase = this.getCurrentPhaseFn();
    this.state.phase = phase;
    // Phase-aware model: Sonnet for active trading phases, Haiku for monitoring phases.
    const PHASE_MODELS = {
      market_open:  'anthropic/claude-sonnet-4-6',
      market_close: 'anthropic/claude-sonnet-4-6',
      pre_market:   'anthropic/claude-haiku-4-5-20251001',
      midday:       'anthropic/claude-haiku-4-5-20251001',
      after_hours:  'anthropic/claude-haiku-4-5-20251001',
      closed:       'anthropic/claude-haiku-4-5-20251001',
    };
    const model = PHASE_MODELS[phase] ?? this.state.activeModel;

    this.state.emit('beat_start', { beat: beatNum, phase, time: this.state.lastBeatTime });
    this.state.emit('agent_log', {
      message: `--- Heartbeat #${beatNum} | ${PHASE_DEFAULTS[phase].label} ---`,
      level: 'info',
    });

    // Build permissions context for the prompt
    const perms = this._resolvePermissions();
    const permLines = [];
    if (!perms.allowLiveTrading) permLines.push('READ-ONLY MODE: Do NOT place any orders. Analysis and monitoring only.');
    if (!perms.allowOptions) permLines.push('Options trading is DISABLED.');
    if (!perms.allowStocks) permLines.push('Stock trading is DISABLED.');
    if (!perms.allow0DTE) permLines.push('0DTE options are NOT allowed.');
    if (perms.maxPositionPct) permLines.push(`Max position size: ${perms.maxPositionPct}% of portfolio.`);
    if (perms.maxDeployedPct) permLines.push(`Max deployed capital: ${perms.maxDeployedPct}%.`);
    if (perms.maxDailyLoss) permLines.push(`Max daily loss: ${perms.maxDailyLoss}% — auto-pause if exceeded.`);
    if (perms.maxOpenPositions) permLines.push(`Max open positions: ${perms.maxOpenPositions}.`);
    if (perms.maxOrderValue > 0) permLines.push(`Max single order value: $${perms.maxOrderValue}.`);
    if (perms.blockedTools?.length) permLines.push(`Blocked tools (do NOT call): ${perms.blockedTools.join(', ')}.`);
    const permStr = permLines.length ? '\n\nGUARDRAILS:\n' + permLines.join('\n') : '';

    const saudiPhase = getSaudiPhase();
    const saudiContext = saudiPhase !== 'saudi_closed'
      ? `\nSaudi Tadawul: ${saudiPhase === 'saudi_open' ? 'OPEN' : 'PRE-MARKET'} — call get_saudi_market_intelligence for Saudi research signals. Log signals with log_decision using .SR ticker symbols.`
      : '';

    const prompt = `[HEARTBEAT #${beatNum}] Phase: ${PHASE_DEFAULTS[phase].label}. Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET. Current heartbeat interval: ${this.state.heartbeatSeconds}s.${permStr}${saudiContext}\n\nPerform your duties for this phase.`;

    try {
      const result = await this._runClaude(prompt, model);
      if (result.error) {
        throw new Error(result.error);
      }
      // Text already streamed via _handleOpenCodeEvent agent_text events
      if (result.toolCalls) this.state.stats.toolCalls += result.toolCalls;

      // Save session ID for continuation
      const effectiveSessionId = result.sessionEpoch === this._sessionEpoch ? result.sessionId : null;
      if (effectiveSessionId) this._sessionId = effectiveSessionId;
      await this._persistSession(effectiveSessionId, { mode: 'heartbeat' });
      await this._persistMessages(effectiveSessionId, [
        { role: 'assistant', kind: 'heartbeat', beat: beatNum, phase, toolCalls: result.toolCalls || 0, content: result.text || '' },
      ]);

    } catch (err) {
      this.state.stats.errors++;
      this.state.emit('agent_log', { message: `Beat #${beatNum} error: ${err.message}`, level: 'error' });
      console.error(`Beat #${beatNum} error:`, err);
    }

    this.state.emit('beat_end', { beat: beatNum, phase });
    
    // Reset session if sessionMode is 'fresh' - start fresh each beat
    if (this._agentConfig?.sessionMode === 'fresh') {
      this._sessionId = null;
      this.state.emit('agent_log', { message: '[session] Resetting for fresh start next beat', level: 'info' });
    }
    
    this._beating = false;
  }

  /**
   * Run opencode as subprocess with MCP tools and stream JSON events
   */
  _runClaude(prompt, model) {
    return new Promise((resolve, reject) => {
      const sessionEpoch = this._sessionEpoch;
      // OpenCode model format: anthropic/claude-sonnet-4-6
      const ocModel = model?.includes('/') ? model : `anthropic/${model || 'claude-sonnet-4-6'}`;

      // Check max tool rounds from permissions
      const perms = this._resolvePermissions();
      const maxToolRounds = perms.maxToolRoundsPerBeat || 25;

      const args = [
        'run',
        '--format', 'json',
        '--model', ocModel,
      ];

      // Continue session if we have one
      if (this._sessionId) {
        args.push('--session', this._sessionId);
      }

      // Only include system prompt on first beat (new session) — subsequent beats
      // on the same session already have it in context, saving ~2000 tokens/beat
      const isNewSession = !this._sessionId;
      const fullPrompt = isNewSession
        ? `[SYSTEM INSTRUCTIONS - Follow these at all times]\n${this.systemPrompt}\n\n[END SYSTEM INSTRUCTIONS]\n\n${prompt}`
        : prompt;

      if (!this._isMessageBeat) {
        this.state.emit('agent_log', {
          message: `Spawning opencode (${ocModel})...`,
          level: 'info',
        });
      }

      const proc = spawn(OPENCODE_BIN, args, {
        cwd: process.cwd(),
        shell: OPENCODE_SHELL,
        env: {
          ...process.env,
          ...this.opencodeEnv,
          OPENPROPHET_SANDBOX_ID: this.sandboxId || '',
          OPENPROPHET_ACCOUNT_ID: this.state.activeAccountId || this.accountId || '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Store reference so sendMessage() can kill it for interrupts
      this._proc = proc;
      this._interrupted = false;

      // Write prompt via stdin then close it
      proc.stdin.on('error', (err) => {
        this.state.emit('agent_log', { message: `stdin error: ${err.message}`, level: 'error' });
      });
      proc.stdin.write(fullPrompt);
      proc.stdin.end();

      let fullText = '';
      let toolCalls = 0;
      let sessionId = null;
      let buffer = '';
      let totalCost = 0;
      let totalTokens = 0;

      proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            this._handleOpenCodeEvent(event, {
              addToolCall: () => toolCalls++,
              addText: (t) => { fullText += t; },
              setSession: (id) => { sessionId = id; },
              addCost: (c) => { totalCost += c; },
              addTokens: (t) => { totalTokens += t; },
            });
          } catch { /* skip unparseable lines */ }
        }
      });

      proc.stderr.on('data', (chunk) => {
        const msg = chunk.toString().trim();
        if (msg) {
          this.state.emit('agent_log', { message: `[opencode] ${msg}`, level: 'info' });
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn opencode: ${err.message}`));
      });

      proc.on('exit', (code, signal) => {
        // Clear proc reference and cancel safety timeout
        this._proc = null;
        if (this._beatTimeout) { clearTimeout(this._beatTimeout); this._beatTimeout = null; }

        // Process remaining buffer
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer);
            this._handleOpenCodeEvent(event, {
              addToolCall: () => toolCalls++,
              addText: (t) => { fullText += t; },
              setSession: (id) => { sessionId = id; },
              addCost: (c) => { totalCost += c; },
              addTokens: (t) => { totalTokens += t; },
            });
          } catch {}
        }

        if (totalCost > 0) {
          this.state.emit('agent_log', {
            message: `Beat cost: $${totalCost.toFixed(4)} | Tokens: ${totalTokens}`,
            level: 'info',
          });
        }

        // If we were interrupted by a user message, resolve gracefully
        if (this._interrupted) {
          this.state.emit('agent_log', {
            message: `Beat interrupted by user (collected ${fullText.length} chars, ${toolCalls} tools before interrupt)`,
            level: 'warning',
          });
          resolve({ text: fullText, toolCalls, sessionId, interrupted: true, sessionEpoch });
          return;
        }

        this.state.emit('agent_log', {
          message: `opencode exited (code: ${code}, signal: ${signal}, text: ${fullText.length} chars, tools: ${toolCalls})`,
          level: code === 0 ? 'info' : 'warning',
        });

        if (code !== 0 && code !== null && !fullText) {
          resolve({ error: `opencode exited with code ${code} signal ${signal}`, text: fullText, toolCalls, sessionId, sessionEpoch });
        } else if (signal && !fullText) {
          resolve({ error: `opencode killed by ${signal}`, text: fullText, toolCalls, sessionId, sessionEpoch });
        } else {
          resolve({ text: fullText, toolCalls, sessionId, sessionEpoch });
        }
      });

      // Safety timeout - 5 minutes max per beat
      this._beatTimeout = setTimeout(() => {
        if (proc && !proc.killed) {
          this.state.emit('agent_log', { message: 'Beat timed out (5 min max), killing process.', level: 'warning' });
          proc.kill('SIGTERM');
        }
      }, 300000);
    });
  }

  /**
   * Handle OpenCode JSON stream events:
   *   step_start  - new LLM turn
   *   text        - assistant text output
   *   tool_use    - tool call with input/output already resolved
   *   step_finish - turn complete with cost/token info
   */
  _handleOpenCodeEvent(event, ctx) {
    const beatNum = this.state.beatCount;

    // Capture session ID from any event
    if (event.sessionID && !this._sessionId) {
      ctx.setSession(event.sessionID);
    }

    switch (event.type) {
      case 'text': {
        const text = event.part?.text;
        if (text?.trim()) {
          ctx.addText(text);
          this.state.emit('agent_text', { text, beat: beatNum });
        }
        break;
      }

      case 'tool_use': {
        const part = event.part || {};
        const toolName = (part.tool || '??').replace('prophet_', ''); // strip MCP prefix for display
        const toolInput = part.state?.input || {};
        const toolOutput = part.state?.output || '';
        const fullToolName = part.tool || toolName;

        ctx.addToolCall();
        this.state.stats.toolCalls++;

        // Emit tool call event
        this.state.emit('tool_call', { name: toolName, args: toolInput, beat: beatNum });

        // Emit tool result
        const resultStr = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput);
        this.state.emit('tool_result', { name: toolName, result: resultStr.substring(0, 500), beat: beatNum });

        // Track trades
        const ORDER_TOOL_PATTERNS = ['place_buy_order', 'place_sell_order', 'place_options_order', 'place_managed_position', 'close_managed_position', 'cancel_order'];
        if (ORDER_TOOL_PATTERNS.some(p => fullToolName.includes(p))) {
          this.state.stats.trades++;
          // For options, prefer underlying ticker; OCC symbol contains it as leading letters
          const rawSymbol = toolInput.underlying || toolInput.symbol || '';
          const symbol = rawSymbol.match(/^[A-Z]+/)?.[0] || rawSymbol || '??';
          const side = toolInput.side || (fullToolName.includes('buy') ? 'buy' : 'sell');
          const qty = toolInput.quantity || toolInput.qty || '?';
          const price = toolInput.limit_price ? ` @ $${toolInput.limit_price}` : '';
          const contract = toolInput.symbol || toolInput.underlying || symbol;
          const action = fullToolName.includes('close') ? 'CLOSE' : side.toUpperCase();
          const isOption = fullToolName.includes('options');
          const typeLabel = isOption ? 'OPTIONS' : 'EQUITY';
          const beat = beatNum;
          const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });

          this.state.addTrade({
            type: 'order',
            tool: toolName,
            symbol,
            side,
            quantity: qty,
            price: toolInput.limit_price,
          });

          // Fire Telegram signal
          const msg = `<b>OpenProphet Signal</b>\n` +
            `${symbol} • ${action} ${typeLabel}\n` +
            `Contract: <code>${contract}</code>\n` +
            `Size: ${qty} contract${qty !== 1 ? 's' : ''}${price}\n` +
            `Beat #${beat} • ${now} ET`;
          sendTelegramSignal(msg);
        }

        // Saudi signal detection — fire Telegram when log_decision is called with a .SR or KSA symbol
        if (toolName.includes('log_decision')) {
          const sym = toolInput.symbol || '';
          if (sym.endsWith('.SR') || sym === 'KSA') {
            const action = toolInput.action || toolInput.decision || 'SIGNAL';
            const thesis = toolInput.reasoning || toolInput.rationale || toolInput.notes || '';
            const price = toolInput.market_data?.price || toolInput.price || null;
            sendSaudiTelegramSignal(sym, action, thesis, price);
          }
        }
        break;
      }

      case 'step_finish': {
        const part = event.part || {};
        if (part.cost) ctx.addCost(part.cost);
        if (part.tokens?.total) ctx.addTokens(part.tokens.total);
        break;
      }

      case 'step_start':
        // Just informational, nothing to do
        break;
    }
  }
}
