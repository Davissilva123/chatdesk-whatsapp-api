export function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - Status: ${res.statusCode} (${duration}ms)`);
  });
  next();
}

export function logEvent(level, context, message, details = null) {
  const logObj = {
    timestamp: new Date().toISOString(),
    level,
    context,
    message,
    ...(details && { details })
  };
  console.log(JSON.stringify(logObj));
}
