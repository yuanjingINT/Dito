/** relay/server.mjs 的类型声明（供桌面端 TS 导入；运行时由 tsx 直接加载 mjs） */
export interface RelayHandle {
  port: number;
  issuePairToken(room: string): { token: string; url: string } | null;
  close(): Promise<void>;
}

export function startRelay(opts?: {
  port?: number;
  host?: string;
  /** 配对 URL 对外基址（如 https://relay.example.com）；缺省用局域网 IP */
  baseUrl?: string;
  /** /p/<room> 服务该目录下的 PWA 静态文件；缺省用内置极简配对页 */
  pwaDir?: string | null;
  log?: (msg: string) => void;
}): Promise<RelayHandle>;
