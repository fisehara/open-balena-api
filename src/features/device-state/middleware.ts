import type { RequestHandler } from 'express';
import * as _ from 'lodash';
import { multiCacheMemoizee } from '../../infra/cache';
import type { Device } from '../../balena-model';

import { sbvrUtils, permissions } from '@balena/pinejs';
import { DEVICE_EXISTS_CACHE_TIMEOUT } from '../../lib/config';

const { api } = sbvrUtils;

const $select = 'id' as const;
const checkDeviceExistsQuery = _.once(() =>
	api.resin.prepare<{ uuid: string }>({
		resource: 'device',
		passthrough: { req: permissions.root },
		id: {
			uuid: { '@': 'uuid' },
		},
		options: {
			$select,
		},
	}),
);
export const checkDeviceExists = multiCacheMemoizee(
	async (uuid: string): Promise<number | undefined> => {
		const device = (await checkDeviceExistsQuery()({ uuid })) as
			| Pick<Device, typeof $select>
			| undefined;
		return device?.id;
	},
	{
		cacheKey: 'checkDeviceExists',
		promise: true,
		primitive: true,
		undefinedAs: false,
		maxAge: DEVICE_EXISTS_CACHE_TIMEOUT,
	},
);

export interface ResolveDeviceInfoCustomObject {
	resolvedDevice: Device['id'];
}

export const resolveOrGracefullyDenyDevices: RequestHandler = async (
	req,
	res,
	next,
) => {
	const device = await checkDeviceExists(req.params.uuid);
	if (device == null) {
		// Gracefully deny deleted devices
		const returnCode = req.method === 'GET' ? 304 : 200;
		res.status(returnCode).end();
		return;
	}

	req.custom ??= {};
	(req.custom as ResolveDeviceInfoCustomObject).resolvedDevice = device;
	next();
};
