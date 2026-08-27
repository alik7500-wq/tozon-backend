export class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let status = err.status || 'error';
  let message = err.message || 'Произошла непредвиденная ошибка';

  // Sanitize PostgreSQL driver errors into user-friendly business responses
  if (err.message && typeof err.message === 'string') {
    if (err.message.includes('invalid input syntax for type bigint') || err.message.includes('invalid input syntax for type integer')) {
      statusCode = 400;
      status = 'fail';
      message = 'Некорректный идентификатор сущности (ожидается числовое значение)';
    } else if (err.message.includes('foreign key constraint') || err.message.includes('violates foreign key')) {
      statusCode = 400;
      status = 'fail';
      message = 'Связанная запись не найдена в базе данных';
    } else if (err.message.includes('duplicate key value violates unique constraint') || err.message.includes('unique constraint')) {
      statusCode = 409;
      status = 'fail';
      message = 'Запись с такими уникальными данными уже существует';
    }
  }

  if (process.env.NODE_ENV === 'development') {
    res.status(statusCode).json({
      status,
      message,
      error: err,
      stack: err.stack,
    });
  } else {
    // Production
    console.error('SERVER ERROR 💥:', err);
    res.status(statusCode).json({
      status,
      message: statusCode < 500 ? message : 'Произошла ошибка при обработке запроса',
    });
  }
};

