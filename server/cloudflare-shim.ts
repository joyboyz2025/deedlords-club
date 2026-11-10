// Thay cho module "cloudflare:workers" khi chạy trên máy thường, để hai game dùng đúng một mã phòng chơi.

export class DurableObject {
  protected ctx: unknown;
  protected env: unknown;

  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
