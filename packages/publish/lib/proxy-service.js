/**
 * `awt site proxy --install`: the proxy as a user service, so it is up after login
 * and after a crash without anyone starting it.
 *
 * One service per config file, named after it: `proxy.json` is `awt-proxy-proxy`,
 * `work.json` is `awt-proxy-work`. Two configs are two services on two ports, which
 * is how a personal and a work proxy run side by side.
 *
 * | Platform | Mechanism                 | Written                                        | Log                                 |
 * |----------|---------------------------|------------------------------------------------|-------------------------------------|
 * | macOS    | launchd agent             | `~/Library/LaunchAgents/dev.awt.proxy.<n>.plist` | `~/Library/Logs/awt-proxy-<n>.log`  |
 * | Linux    | systemd user unit         | `~/.config/systemd/user/awt-proxy-<n>.service` | the journal                         |
 * | Windows  | Task Scheduler, at logon  | `%LOCALAPPDATA%\awt\awt-proxy-<n>.cmd`         | `%LOCALAPPDATA%\awt\awt-proxy-<n>.log` |
 *
 * **The service runs this awt by absolute path, with the PATH of the shell that
 * installed it.** A service starts with almost no environment, and `awt site
 * serve` needs `node` to run Quartz. Reinstall after moving either.
 *
 * Windows' Task Scheduler restarts nothing on its own when started from the
 * command line, and its `/TR` is capped at 261 characters, so it runs a small
 * `.cmd` that loops.
 *
 * What is built is data — a file and the commands to run — so every platform's
 * output is testable on any one, and `--dry-run` shows it without running it.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

export function serviceName(configFile) {
  const base = configFile.split(/[\\/]/).pop().replace(/\.json$/i, "")
  return `awt-proxy-${base.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`
}

const xml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
const systemdQuote = (arg) => `"${String(arg).replace(/(["\\])/g, "\\$1").replace(/%/g, "%%")}"`
const cmdQuote = (arg) => `"${String(arg).replace(/"/g, '""')}"`

/**
 * The service for one config: `{name, file, content, install, uninstall}`, where
 * `install` and `uninstall` are commands as argv arrays, run in order. A command
 * marked `optional` may fail — stopping a service that is not running.
 */
export function serviceFor({ platform, configFile, command, env = process.env, home = os.homedir(), uid = process.getuid?.() }) {
  const name = serviceName(configFile)
  const argv = [...command, "site", "proxy", "--config", configFile]
  const PATH = env.PATH ?? env.Path ?? ""

  if (platform === "darwin") {
    const label = `dev.awt.proxy.${name.slice("awt-proxy-".length)}`
    const file = path.posix.join(home, "Library", "LaunchAgents", `${label}.plist`)
    const logFile = path.posix.join(home, "Library", "Logs", `${name}.log`)
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(PATH)}</string></dict>
  <key>WorkingDirectory</key><string>${xml(home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`
    const domain = `gui/${uid}`
    return {
      name,
      file,
      content,
      log: logFile,
      install: [
        { argv: ["launchctl", "bootout", `${domain}/${label}`], optional: true },
        { argv: ["launchctl", "bootstrap", domain, file] },
      ],
      uninstall: [{ argv: ["launchctl", "bootout", `${domain}/${label}`], optional: true }],
    }
  }

  if (platform === "linux") {
    const base = env.XDG_CONFIG_HOME || path.posix.join(home, ".config")
    const file = path.posix.join(base, "systemd", "user", `${name}.service`)
    const content = `[Unit]
Description=awt site proxy (${configFile})

[Service]
ExecStart=${argv.map(systemdQuote).join(" ")}
Environment=${systemdQuote(`PATH=${PATH}`)}
WorkingDirectory=${home}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`
    const unit = `${name}.service`
    return {
      name,
      file,
      content,
      log: `journalctl --user -u ${unit}`,
      install: [
        { argv: ["systemctl", "--user", "daemon-reload"] },
        { argv: ["systemctl", "--user", "enable", unit] },
        { argv: ["systemctl", "--user", "restart", unit] },
      ],
      uninstall: [
        { argv: ["systemctl", "--user", "disable", "--now", unit], optional: true },
        { argv: ["systemctl", "--user", "daemon-reload"], optional: true },
      ],
    }
  }

  if (platform === "win32") {
    const dir = path.win32.join(env.LOCALAPPDATA ?? path.win32.join(home, "AppData", "Local"), "awt")
    const file = path.win32.join(dir, `${name}.cmd`)
    const logFile = path.win32.join(dir, `${name}.log`)
    const content = [
      "@echo off",
      `rem awt site proxy for ${configFile}. Written by awt site proxy --install; restarts the proxy if it exits.`,
      `set "PATH=${PATH}"`,
      `cd /d ${cmdQuote(home)}`,
      ":loop",
      `${argv.map(cmdQuote).join(" ")} >> ${cmdQuote(logFile)} 2>&1`,
      "timeout /t 5 /nobreak > nul",
      "goto loop",
      "",
    ].join("\r\n")
    return {
      name,
      file,
      content,
      log: logFile,
      install: [
        { argv: ["schtasks", "/End", "/TN", name], optional: true },
        { argv: ["schtasks", "/Create", "/F", "/TN", name, "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", cmdQuote(file)] },
        { argv: ["schtasks", "/Run", "/TN", name] },
      ],
      uninstall: [
        { argv: ["schtasks", "/End", "/TN", name], optional: true },
        { argv: ["schtasks", "/Delete", "/F", "/TN", name], optional: true },
      ],
    }
  }

  throw new Error(`no service install for ${platform}; run \`awt site proxy\` from your own startup instead`)
}

/** Write the service and start it, or with `dryRun` only say what that would do. */
export function installService(service, { dryRun = false, out = console.log } = {}) {
  out(`${dryRun ? "would write" : "writing"} ${service.file}`)
  if (dryRun) out(`\n${service.content}`)
  else {
    fs.mkdirSync(path.dirname(service.file), { recursive: true })
    fs.writeFileSync(service.file, service.content)
  }
  return runAll(service.install, { dryRun, out }) && (out(`log: ${service.log}`), true)
}

/** Stop the service and remove its file. */
export function uninstallService(service, { dryRun = false, out = console.log } = {}) {
  const ok = runAll(service.uninstall, { dryRun, out })
  out(`${dryRun ? "would remove" : "removing"} ${service.file}`)
  if (!dryRun) fs.rmSync(service.file, { force: true })
  return ok
}

function runAll(commands, { dryRun, out }) {
  for (const { argv, optional } of commands) {
    out(`${dryRun ? "would run" : "running"}: ${argv.join(" ")}`)
    if (dryRun) continue
    const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", windowsHide: true })
    if (result.status !== 0 && !optional) {
      out(`failed: ${(result.stderr || result.stdout || result.error?.message || "").trim()}`)
      return false
    }
  }
  return true
}
