/** An expected error with an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody() {
    return { error: { code: this.code, message: this.message, ...(this.details && { details: this.details }) } };
  }
}

export const badRequest = (code, message, details) => new AppError(400, code, message, details);
export const unprocessable = (code, message, details) => new AppError(422, code, message, details);
