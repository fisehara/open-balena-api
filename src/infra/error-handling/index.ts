import * as _ from 'lodash';
import * as Sentry from '@sentry/node';
import escapeHtml = require('escape-html');

import { hooks, errors, sbvrUtils } from '@balena/pinejs';

const { InternalRequestError, HttpError } = errors;

export const translateError = (err: Error | number | string): string => {
	if (err instanceof InternalRequestError) {
		return 'Server Error';
	}
	let message;
	if (err instanceof HttpError) {
		captureException(
			new Error(),
			'Translating a HttpError, this should go via handleHttpErrors instead',
		);
		message = err.message;
	} else if (err instanceof Error) {
		message = err.message;
	} else {
		message = `${err}`;
	}
	return escapeHtml(message);
};

export function captureException(
	err: Error,
	message?: string,
	options?: {
		tags?: { [key: string]: string };
		req?: Sentry.Handlers.ExpressRequest | hooks.HookReq;
		extra?: AnyObject;
	},
): void {
	// if err does not have a message or a stack, we have no information about that error
	if (_.isObject(err) && err.message == null) {
		console.error(message, err);
	} else {
		console.error(message, err.message, err.stack);
	}

	Sentry.withScope((scope) => {
		if (options != null) {
			const { tags, req, extra } = options;
			if (tags != null) {
				scope.setTags(tags);
			}
			if (req != null) {
				scope.addEventProcessor((evt) =>
					Sentry.Handlers.parseRequest(evt, req),
				);
			}
			if (extra != null) {
				scope.setExtras(extra);
			}
		}

		if (message) {
			// Trim mostly for removing trailing new lines intended for the console
			message = message.trim();
			scope.setExtra('message', message);
			// We throw some errors where the constructor receives no message
			// But also sometimes `err` is not really an Error, f.e a number
			if (err instanceof Error && !err.message) {
				err.message = message;
			}
		}

		Sentry.captureException(err);
	});
}

sbvrUtils.onHandleHttpError((req, err) => {
	if (err instanceof InternalRequestError) {
		captureException(err, 'Internal server error', { req });
		err.body ??= 'Server error';
	}
});
export const { handleHttpErrors } = sbvrUtils;
