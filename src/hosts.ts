// Host-name rules shared by production code. The in-process sandbox network (development tests only) uses this suffix; the
// production marketplace refuses to list, show or sell anything on such a host.
export const SANDBOX_SUFFIX = '.sandbox.payrail.example';
const SANDBOX_HOST = /^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?\.sandbox\.payrail\.example$/;
export const isSandboxHost = (h: string): boolean => SANDBOX_HOST.test(h);
