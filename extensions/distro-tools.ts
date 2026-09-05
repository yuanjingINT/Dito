/**
 * Dito 发行版专属工具：AUR 搜索 / 红绿灯审查（Arch）、COPR 仓库检索（Fedora）。
 *
 * aur_search / aur_review / copr_search 是只读联网查询，不执行安装、不改动本机；
 * aur_install 只生成安装命令，真正的执行交给 bash 工具并经过权限门/用户确认。
 *
 * - aur_search   搜索 AUR
 * - aur_review   拉取 PKGBUILD + 元数据，做危险信号初筛，输出「红 / 黄 / 绿」初步结论
 * - aur_install  检查 AUR 包并生成 paru/yay 安装命令
 * - copr_search  搜索 Fedora COPR 仓库
 */
import { spawnSync } from "node:child_process";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const UA = { "User-Agent": "dito/0.1 (+aur-review)" };

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const resp = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as Record<string, unknown>;
}

async function fetchText(url: string): Promise<string> {
  const resp = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}\n…（已截断，共 ${s.length} 字符）` : s;
}

// ── AUR ────────────────────────────────────────────────────────

interface AurPackage {
  Name?: string;
  PackageBase?: string;
  Description?: string | null;
  Version?: string;
  Maintainer?: string | null;
  NumVotes?: number;
  Popularity?: number;
  OutOfDate?: number | null;
  URL?: string | null;
  Depends?: string[];
  MakeDepends?: string[];
  OptDepends?: string[];
  License?: string[];
}

async function aurSearch(query: string): Promise<unknown[]> {
  const url = `https://aur.archlinux.org/rpc/?v=5&type=search&arg=${encodeURIComponent(query)}`;
  const d = await fetchJson(url);
  return (d.results as unknown[]) ?? [];
}

async function aurInfo(pkg: string): Promise<AurPackage | null> {
  const url = `https://aur.archlinux.org/rpc/?v=5&type=info&arg[]=${encodeURIComponent(pkg)}`;
  const d = await fetchJson(url);
  const arr = d.results as AurPackage[] | undefined;
  return arr?.[0] ?? null;
}

async function aurRawFile(pkgbase: string, file: string): Promise<string> {
  const url = `https://aur.archlinux.org/cgit/aur.git/plain/${file}?h=${encodeURIComponent(pkgbase)}`;
  return fetchText(url);
}

// 检测系统里可用的 AUR helper（paru 优先，其次 yay）。
function detectAurHelper(): string {
  for (const helper of ["paru", "yay"]) {
    const r = spawnSync("sh", ["-c", `command -v ${helper}`], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return helper;
  }
  return "paru";
}

// ── 红绿灯危险信号初筛 ────────────────────────────────────────

interface FlagCheck {
  level: "red" | "yellow";
  re: RegExp;
  label: string;
}

const RED_FLAGS: FlagCheck[] = [
  { level: "red", re: /\b(curl|wget)\b[^\n;|]*\|[ \t]*(ba|da|z|k)?sh\b/, label: "curl/wget 结果直接管道给 shell 执行（curl|bash 类）" },
  { level: "red", re: /\brm\s+-rf\s+(?:--no-preserve-root\s+)?(\/|\/\*|\$HOME|\/home|\/boot|\/etc|\/usr|\/var|~)\b/, label: "危险的 rm -rf（指向根目录/家目录/系统目录）" },
  { level: "red", re: /\b(base64\s+-d|base64\s+--decode|xxd\s+-r\s+-p|eval\s+)/, label: "base64/xxd 解码或 eval 执行（疑似混淆）" },
  { level: "red", re: /\b(dd\s+if=|printf\s+['"]\\x)/, label: "dd/printf 直接写二进制（疑似混淆 payload）" },
];

const YELLOW_FLAGS: FlagCheck[] = [
  { level: "yellow", re: /curl\s+[^\n]*(-k|--insecure)\b/, label: "下载时跳过证书校验（-k/--insecure）" },
  { level: "yellow", re: /\b(git\s+clone|svn\s+checkout|hg\s+clone)\b[^\n;|]*&&/, label: "版本库拉取后立即链式执行" },
  { level: "yellow", re: /\.(AppImage|deb|rpm|exe|bin)\b/i, label: "包含预编译二进制（AppImage/deb/rpm/exe/bin）" },
  { level: "yellow", re: /\bsudo\s+(make|install|cp|mv|rm)\b/, label: "构建脚本内使用 sudo 提权操作" },
];

function analyzePkgbuild(pkgbuild: string): { flags: string[]; signal: "red" | "yellow" | "green" } {
  const flags: string[] = [];
  for (const c of RED_FLAGS) if (c.re.test(pkgbuild)) flags.push(`[红灯] ${c.label}`);
  for (const c of YELLOW_FLAGS) if (c.re.test(pkgbuild)) flags.push(`[黄灯] ${c.label}`);
  const signal = flags.some((f) => f.startsWith("[红灯]")) ? "red" : flags.length ? "yellow" : "green";
  return { flags, signal };
}

const SIGNAL_LABEL: Record<string, string> = {
  red: "红灯（别装）",
  yellow: "黄灯（谨慎）",
  green: "绿灯（可装）",
};

// ── COPR ───────────────────────────────────────────────────────

interface CoprProject {
  name?: string;
  ownername?: string;
  full_name?: string;
  description?: string | null;
  homepage?: string | null;
  instructions?: string | null;
}

async function coprSearch(query: string): Promise<unknown[]> {
  const url = `https://copr.fedorainfracloud.org/api_3/project/search?query=${encodeURIComponent(query)}`;
  const d = await fetchJson(url);
  const items = (d.items as CoprProject[]) ?? [];
  return items.map((it) => ({
    full_name: it.full_name || `${it.ownername}/${it.name}`,
    owner: it.ownername ?? "",
    name: it.name ?? "",
    description: truncate(it.description ?? "", 200),
    homepage: it.homepage ?? "",
    instructions: truncate(it.instructions ?? "", 500),
    enable_cmd: `sudo dnf copr enable ${it.full_name || `${it.ownername}/${it.name}`}`,
  }));
}

// ── 工具注册 ───────────────────────────────────────────────────

export function registerDistroTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "aur_search",
    label: "搜索 AUR",
    description: "在 Arch 用户仓库（AUR）里搜索软件包，返回包名、版本、简介、维护者、投票数、是否过期、上游链接。",
    parameters: Type.Object({
      query: Type.String({ description: "搜索关键词，如 hyprland、wechat、nvidia" }),
    }),
    async execute(_id, params) {
      try {
        const results = (await aurSearch(params.query)) as AurPackage[];
        const slim = results.slice(0, 12).map((r) => ({
          name: r.Name,
          version: r.Version,
          description: r.Description ?? "",
          maintainer: r.Maintainer ?? "(孤儿)",
          votes: r.NumVotes ?? 0,
          popularity: Number((r.Popularity ?? 0).toFixed(2)),
          out_of_date: r.OutOfDate ? true : false,
          url: r.URL ?? "",
        }));
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, count: slim.length, results: slim }, null, 2) }],
          details: { ok: true, count: slim.length },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: (err as Error).message }) }],
          details: { ok: false },
        };
      }
    },
  });

  pi.registerTool({
    name: "aur_review",
    label: "AUR 红绿灯审查",
    description:
      "拉取指定 AUR 包的元数据与 PKGBUILD（含 .SRCINFO），做危险信号初筛，输出「红/黄/绿」初步结论与命中项，供你结合审查规则给出最终红绿灯结论。",
    parameters: Type.Object({
      pkgname: Type.String({ description: "AUR 包名（PackageBase 或 Name），如 yay、wechat-universal-bwrap" }),
    }),
    async execute(_id, params) {
      const pkg = params.pkgname as string;
      try {
        const info = await aurInfo(pkg);
        if (!info) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: `AUR 中未找到包：${pkg}`, note: "用 aur_search 先确认包名（注意 PackageBase 与 Name 的区别）" }) }],
            details: { ok: false },
          };
        }
        const base = info.PackageBase || info.Name || pkg;
        let pkgbuild = "";
        let srcinfo = "";
        try {
          pkgbuild = await aurRawFile(base, "PKGBUILD");
        } catch {
          pkgbuild = "";
        }
        try {
          srcinfo = await aurRawFile(base, ".SRCINFO");
        } catch {
          srcinfo = "";
        }

        const analysis = analyzePkgbuild(pkgbuild);
        const notes = [...analysis.flags];
        if (info.OutOfDate) notes.push("[黄灯] 包已标记过期（OutOfDate），可能缺维护");
        if ((info.NumVotes ?? 0) === 0) notes.push("[提示] 0 票包，务必核对维护者与上游仓库");
        if (!info.Maintainer) notes.push("[黄灯] 无维护者（孤儿包）");

        // 综合初筛：红灯优先，其次黄灯，否则绿灯。
        const signal = analysis.signal;
        const summary = {
          ok: true,
          pkgbase: base,
          metadata: {
            name: info.Name,
            version: info.Version,
            description: info.Description ?? "",
            maintainer: info.Maintainer ?? "(孤儿)",
            votes: info.NumVotes ?? 0,
            popularity: Number((info.Popularity ?? 0).toFixed(2)),
            out_of_date: info.OutOfDate ? true : false,
            url: info.URL ?? "",
            license: info.License ?? [],
            depends: info.Depends ?? [],
            make_depends: info.MakeDepends ?? [],
            opt_depends: info.OptDepends ?? [],
          },
          preliminary: { signal, verdict: SIGNAL_LABEL[signal], hits: notes },
          pkgbuild: truncate(pkgbuild, 8000),
          srcinfo: truncate(srcinfo, 4000),
          reminder:
            "以上是初步机器初筛（只查常见危险信号），不能替代人工审查。请通读 PKGBUILD 的函数体与 source 数组，结合「红绿灯审查规则」给出最终红/黄/绿结论，并说明依据；红灯必须明确劝阻，黄灯列出需用户确认的点。",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
          details: { ok: true, signal },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: (err as Error).message }) }],
          details: { ok: false },
        };
      }
    },
  });


  pi.registerTool({
    name: "aur_install",
    label: "安装 AUR 包",
    description:
      "检查指定 AUR 包是否存在，并生成 paru/yay 安装命令。命令本身不在此工具内执行，请用 bash 工具执行（会经过权限门与用户确认）。默认不传 helper 时自动检测 paru 或 yay。",
    parameters: Type.Object({
      pkg: Type.String({ description: "要安装的 AUR 包名（可多个，空格分隔），如 yay wechat-universal-bwrap" }),
      helper: Type.Optional(Type.String({ description: "AUR helper：paru 或 yay；留空自动检测" })),
    }),
    async execute(_id, params) {
      const pkgs = String(params.pkg ?? "").trim().split(/\s+/).filter(Boolean);
      if (pkgs.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: "请提供要安装的 AUR 包名" }) }],
          details: { ok: false },
        };
      }

      // 先确认这些包确实存在于 AUR，避免把非 AUR 包或错误包名交给 helper。
      const missing: string[] = [];
      for (const pkg of pkgs) {
        const info = await aurInfo(pkg);
        if (!info) missing.push(pkg);
      }
      if (missing.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: `AUR 中未找到：${missing.join("、")}`,
                note: "先用 aur_search 确认包名（注意 PackageBase 与 Name 的区别）",
              }, null, 2),
            },
          ],
          details: { ok: false },
        };
      }

      const helperRaw = String(params.helper ?? "").trim().toLowerCase();
      const helper = helperRaw ? (helperRaw === "yay" ? "yay" : "paru") : detectAurHelper();
      const cmd = `${helper} -S --noconfirm --needed ${pkgs.join(" ")}`;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              pkg: pkgs,
              helper,
              command: cmd,
              note: "该命令会构建并安装 AUR 包（可能修改系统/安装依赖），请用 bash 工具执行，执行前会经过权限门与用户确认。",
            }, null, 2),
          },
        ],
        details: { ok: true, helper, command: cmd },
      };
    },
  });

  pi.registerTool({
    name: "copr_search",
    label: "搜索 COPR 仓库",
    description: "在 Fedora COPR（第三方软件仓库）里搜索项目，返回 owner/项目名、简介、主页、安装说明与启用命令（sudo dnf copr enable …）。",
    parameters: Type.Object({
      query: Type.String({ description: "搜索关键词，如 nvidia、hyprland、wezterm" }),
    }),
    async execute(_id, params) {
      try {
        const results = await coprSearch(params.query);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: true, count: results.length, note: "安装前先确认仓库作者可信；用 copr_install 生成启用+安装/更新命令", results },
                null,
                2,
              ),
            },
          ],
          details: { ok: true, count: results.length },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: (err as Error).message }) }],
          details: { ok: false },
        };
      }
    },
  });

  pi.registerTool({
    name: "copr_install",
    label: "启用/安装 COPR 仓库",
    description:
      "针对指定 COPR 项目（owner/name），生成「启用仓库 + 安装/更新软件包」的确切 dnf 命令（先经 COPR 校验项目是否存在）。命令本身不在此工具内执行，请用 bash 工具逐条执行（会经过权限门与用户确认）。",
    parameters: Type.Object({
      project: Type.String({ description: "COPR 项目全名 owner/name（从 copr_search 结果的 full_name 取）" }),
      packages: Type.Optional(Type.String({ description: "要安装/更新的软件包名，多个用空格或逗号分隔；留空则只启用仓库" })),
      update_only: Type.Optional(Type.Boolean({ description: "true=只升级已安装的包（dnf upgrade）；默认 false（dnf install，安装或升级到最新）" })),
    }),
    async execute(_id, params) {
      const project = String(params.project ?? "").trim();
      if (!project.includes("/")) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: "请传 owner/name 格式的 COPR 项目全名（从 copr_search 的 full_name 取）" }) }],
          details: { ok: false },
        };
      }
      let verified = false;
      try {
        const namePart = project.split("/")[1] ?? "";
        const hits = (await coprSearch(namePart)) as { full_name?: string }[];
        verified = hits.some((h) => h.full_name === project);
      } catch {
        verified = false;
      }

      const pkgs = String(params.packages ?? "").trim();
      const updateOnly = params.update_only === true;
      const cmds: string[] = [`sudo dnf copr enable ${project}`];
      if (pkgs) {
        const list = pkgs.split(/[\s,]+/).filter(Boolean).join(" ");
        cmds.push(updateOnly ? `sudo dnf upgrade ${list}` : `sudo dnf install ${list}`);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                project,
                verified,
                warning: verified ? "" : "未在 COPR 搜到该项目，请先用 copr_search 核对 full_name 再继续",
                note: "这些命令会写入 /etc/yum.repos.d/ 并可能安装/升级软件，属系统修改操作，执行前必须经用户确认；请用 bash 工具逐条执行（会经过权限门）。",
                commands: cmds,
              },
              null,
              2,
            ),
          },
        ],
        details: { ok: true, verified },
      };
    },
  });
}
