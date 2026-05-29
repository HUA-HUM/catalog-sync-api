const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

export class MeliWebhookLogger {
  static received(message: string) {
    console.log(`${CYAN}[MELI WEBHOOK RECEIVED] ${message}${RESET}`);
  }

  static processing(message: string) {
    console.log(`${MAGENTA}[MELI WEBHOOK WORKER] ${message}${RESET}`);
  }

  static error(message: string, error?: unknown) {
    console.error(`${RED}[MELI WEBHOOK ERROR] ${message}${RESET}`, error);
  }
}
