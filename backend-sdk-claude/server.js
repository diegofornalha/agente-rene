require('dotenv').config();
const path = require('path');
const os = require('os');

// Workspace dos scripts René/Instagram (download/tradução/publicação).
// Portável: sobrescreva com RENE_WORKSPACE no .env. Os scripts Python em si
// (instagram/, linkedin_poster.py, translate-image.py) precisam existir aqui —
// não fazem parte deste repositório.
const RENE_WS = process.env.RENE_WORKSPACE || path.join(os.homedir(), '.hermes', 'workspace');
const SessionContextManager = require('./sessionContext');
const HealthChecker = require('./services/health/health-checker');
const taskRunner = require('./services/tasks/task-runner');
const cronScheduler = require('./services/tasks/cron-scheduler');
const kanban = require('./services/tasks/kanban');
const mcpClient = require('./services/mcp/mcp-client');
const pluginLoader = require('./services/skills/plugin-loader');
const hooksService = require('./services/health/hooks');
const roadmapCron = require('./services/roadmap-cron');
const automationCron = require('./services/automations/automation-cron');


// Logger pluggável (services/logger.js). LOG_BACKEND=console (default) mantém
// o comportamento atual; LOG_BACKEND=pino ativa NDJSON + rotação diária em ./logs/.
const logger = require('./services/logger');

const { app, server, io, upload } = require('./app');

const { startCleanups } = require('./services/chat/session-registry');
startCleanups(io);

// Referência ao canal WhatsApp pra rotas externas (POST /api/whatsapp/say)
let whatsappChannel = null;

// Initialize clients
const sessionContextManager = new SessionContextManager();

// Initialize Health Checker
const healthChecker = new HealthChecker();
const watchdog = require('./services/health/watchdog');
const diskUsage = require('./services/health/disk-usage');
const connStatus = require('./services/health/connection-status');
const healthCron = require('./services/health/health-cron');

// Initialize all systems
async function initializeSystem() {
  console.log('🚀 Initializing Chat Server Systems...');

  try {
    console.log('📋 System Status:');
    console.log('  Session Context: ✅ Active');

  } catch (error) {
    console.error('❌ System initialization error:', error);
  }
}

// Initialize on startup
initializeSystem();

// Autonomous mode
const AUTONOMOUS_INTERVAL = parseInt(process.env.AUTONOMOUS_INTERVAL_MIN || '0') * 60 * 1000;
if (AUTONOMOUS_INTERVAL > 0) {
  taskRunner.startAutonomous(io, AUTONOMOUS_INTERVAL);
}



// Rotas modularizadas — ver routes/*.js
require('./routes/system')(app, { upload, sessionContextManager });
require('./routes/health')(app, { io, healthChecker });

require('./routes/whatsapp')(app, { getWhatsappChannel: () => whatsappChannel, sessionContextManager });
require('./routes/heygen')(app, { getWhatsappChannel: () => whatsappChannel });

require('./routes/tasks')(app);
require('./routes/misc')(app, { io, RENE_WS });
require('./routes/roleplay')(app);
require('./routes/google')(app);

require('./sockets/chat-socket')(io, { sessionContextManager });

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log('🚀 Enhanced Claude Code SDK Server running on port', PORT);
  console.log('📋 Features enabled:');
  console.log('  • Real-time streaming chat');
  console.log('  • File upload and analysis');
  console.log('  • Session management');
  console.log('  • Conversation export');
  console.log('  • Advanced Claude Code SDK integration');
  console.log('  • WebSocket connections for real-time updates');

  // Start health monitoring
  healthChecker.startMonitoring({
    io
  }, 30000); // Check every 30 seconds
  console.log('  • Real-time metrics and monitoring');

  // Start watchdog
  watchdog.start({
    onAlert: (alert) => logger.warn(`🐕 Watchdog [${alert.level}] ${alert.message}`),
  });
  console.log('  • Health watchdog: active');

  // WhatsApp channel (opt-in)
  if (process.env.WHATSAPP_ENABLED === 'true') {
    whatsappChannel = require('./services/whatsapp/whatsapp-channel');
    connStatus.register(whatsappChannel);
    whatsappChannel.start({ io, taskRunner }).catch(err => {
      console.error('❌ WhatsApp channel failed to start:', err);
    });
    console.log('  • WhatsApp channel: enabled');

    // Health cron — alertas de saúde via WhatsApp
    healthCron.start({ whatsappChannel, watchdog, diskUsage, connStatus, logger });
    console.log('  • Health cron: active');

    // Roadmap Paraguai — avisos diários no grupo Rota Fiscal #333
    roadmapCron.start();
    console.log('  • Roadmap cron: active');

    // Automações comerciais (briefing pré-reunião + relatório semanal)
    automationCron.start();
  }

  // Cron scheduler (sempre ligado — sem cron.json = no-op)
  cronScheduler.start({ taskRunner, io });

  // Kanban (sempre ligado — DB lazy-created)
  kanban.start({ taskRunner });

  // MCP client (conecta servidores em data/mcp-servers.json)
  mcpClient.start().catch(err => console.error('MCP start failed:', err.message));

  // Plugins (data/plugins/ + ~/.hermes-mythos/plugins/)
  pluginLoader.start({ hooks: hooksService, taskRunner, app, io })
    .catch(err => console.error('Plugins start failed:', err.message));

  // Auto-rotação de sessões Claude Code (rolling window de 200 por project).
  // Roda agora + a cada 6h. Substitui o launchd plist (bootstrap falha no macOS atual).
  const { exec } = require('child_process');
  const CLEANUP_SCRIPT = path.join(__dirname, 'scripts', 'cleanup-sessions.sh');
  const runCleanup = () => {
    exec(`bash "${CLEANUP_SCRIPT}"`, { env: { ...process.env, KEEP: process.env.SESSIONS_KEEP || '200' } }, (err) => {
      if (err) console.error('⚠️  cleanup-sessions failed:', err.message);
    });
  };
  setTimeout(runCleanup, 30_000);                  // 30s após boot
  setInterval(runCleanup, 6 * 60 * 60 * 1000);     // a cada 6h
  console.log('  • Session cleanup: rolling window 200/project, every 6h');
});