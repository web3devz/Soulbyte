import fs from 'fs';
import path from 'path';

const ERROR_LOG_FILE = process.env.SOULBYTE_ERROR_LOG_FILE
    ? path.resolve(process.env.SOULBYTE_ERROR_LOG_FILE)
    : path.join(process.cwd(), 'logs', 'soulbyte-errors.log');

let ensured = false;

function ensureLogDir() {
    if (ensured) return;
    fs.mkdirSync(path.dirname(ERROR_LOG_FILE), { recursive: true });
    ensured = true;
}

export function logErrorToFile(context: string, error: unknown) {
    ensureLogDir();
    const payload =
        error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : { error };
    const entry = {
        ts: new Date().toISOString(),
        context,
        error: payload,
    };
    fs.appendFile(ERROR_LOG_FILE, `${JSON.stringify(entry)}\n`, () => {});
}

export function getErrorLogPath() {
    return ERROR_LOG_FILE;
}
