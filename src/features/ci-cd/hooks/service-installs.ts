import * as _ from 'lodash';
import { sbvrUtils, hooks, permissions } from '@balena/pinejs';
import type { Filter, FilterObj } from 'pinejs-client-core';
import type {
	Device,
	PickDeferred,
	Service,
	ServiceInstall,
} from '../../../balena-model';

const createReleaseServiceInstalls = async (
	api: sbvrUtils.PinejsClient,
	deviceFilterOrIds: number[] | FilterObj,
	releaseFilter: Filter,
): Promise<void> => {
	if (Array.isArray(deviceFilterOrIds) && deviceFilterOrIds.length === 0) {
		return;
	}

	const services = (await api.get({
		resource: 'service',
		options: {
			$select: 'id',
			$filter: {
				is_built_by__image: {
					$any: {
						$alias: 'i',
						$expr: {
							i: {
								is_part_of__release: {
									$any: {
										$alias: 'ipr',
										$expr: {
											ipr: {
												release: {
													$any: {
														$alias: 'r',
														$expr: { r: releaseFilter },
													},
												},
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
	})) as Array<Pick<Service, 'id'>>;
	if (services.length === 0) {
		return;
	}
	const serviceIds = services.map(({ id }) => id);

	const missingServiceFilters = serviceIds.map((serviceId) => ({
		$not: {
			service_install: {
				$any: {
					$alias: 'si',
					$expr: {
						si: {
							installs__service: serviceId,
						},
					},
				},
			},
		},
	}));

	const devicesToAddServiceInstalls = (await api.get({
		resource: 'device',
		options: {
			$select: 'id',
			$expand: {
				service_install: {
					$select: 'installs__service',
					$filter: {
						installs__service: { $in: serviceIds },
					},
				},
			},
			$filter: {
				// Pass the device filters instead of IDs, since a using $in errors with `code: '08P01'` for more than 66k IDs.
				...(Array.isArray(deviceFilterOrIds)
					? { id: { $in: deviceFilterOrIds } }
					: deviceFilterOrIds),
				// TODO: Once Pine support it, change this with a filtered-count filter like:
				// $filter=... service_install/$filter(installs__service $in (...serviceIds))/$count lt ${serviceIds.length}
				// See: http://docs.oasis-open.org/odata/odata/v4.01/odata-v4.01-part1-protocol.html#sec_RequestingtheNumberofItemsinaCollect
				...(missingServiceFilters.length === 1
					? missingServiceFilters[0]
					: {
							$or: missingServiceFilters,
					  }),
			},
		},
	})) as Array<
		Pick<Device, 'id'> & {
			service_install: Array<PickDeferred<ServiceInstall, 'installs__service'>>;
		}
	>;

	await Promise.all(
		devicesToAddServiceInstalls.map(async (device) => {
			const existingServiceIds = device.service_install.map(
				(si) => si.installs__service.__id,
			);
			const deviceServiceIds = _.difference(serviceIds, existingServiceIds);
			await Promise.all(
				deviceServiceIds.map(async (serviceId) => {
					// Create a service_install for this pair of service and device
					await api.post({
						resource: 'service_install',
						body: {
							device: device.id,
							installs__service: serviceId,
						},
						options: { returnResource: false },
					});
				}),
			);
		}),
	);
};

const createAppServiceInstalls = async (
	api: sbvrUtils.PinejsClient,
	appId: number,
	deviceIds: number[],
): Promise<void> =>
	createReleaseServiceInstalls(api, deviceIds, {
		should_be_running_on__application: {
			$any: {
				$alias: 'a',
				$expr: { a: { id: appId } },
			},
		},
	});

const deleteServiceInstallsForCurrentApp = (
	api: sbvrUtils.PinejsClient,
	deviceIds: number[],
) =>
	api.delete({
		resource: 'service_install',
		options: {
			$filter: {
				device: { $in: deviceIds },
				installs__service: {
					$any: {
						$alias: 's',
						$expr: {
							s: {
								application: {
									$any: {
										$alias: 'a',
										$expr: {
											a: {
												owns__device: {
													$any: {
														$alias: 'd',
														$expr: { d: { id: { $in: deviceIds } } },
													},
												},
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
	});

hooks.addPureHook('PATCH', 'resin', 'application', {
	POSTRUN: async ({ api, request }) => {
		const affectedIds = request.affectedIds!;
		if (
			request.values.should_be_running__release != null &&
			affectedIds.length !== 0
		) {
			// Ensure that every device of the app we've just pinned, that is not itself pinned, has the necessary service install entries.
			await createReleaseServiceInstalls(
				api,
				{
					belongs_to__application: { $in: affectedIds },
					should_be_running__release: null,
				},
				{
					id: request.values.should_be_running__release,
				},
			);
		}
	},
});

hooks.addPureHook('POST', 'resin', 'device', {
	POSTRUN: async ({ request, api, tx, result: deviceId }) => {
		// Don't try to add service installs if the device wasn't created
		if (deviceId == null) {
			return;
		}

		const rootApi = api.clone({ passthrough: { tx, req: permissions.root } });

		await createAppServiceInstalls(
			rootApi,
			request.values.belongs_to__application,
			[deviceId],
		);
	},
});

hooks.addPureHook('PATCH', 'resin', 'device', {
	PRERUN: async (args) => {
		// We need to delete all service_install resources for the current app of these devices
		// and create new ones for the new application (if the device is moving application)
		if (args.request.values.belongs_to__application == null) {
			return;
		}
		const affectedIds = await sbvrUtils.getAffectedIds(args);
		if (affectedIds.length !== 0) {
			await deleteServiceInstallsForCurrentApp(args.api, affectedIds);
			await createAppServiceInstalls(
				args.api,
				args.request.values.belongs_to__application,
				affectedIds,
			);
		}
	},
});

hooks.addPureHook('PATCH', 'resin', 'device', {
	POSTRUN: async ({ api, request }) => {
		const affectedIds = request.affectedIds!;
		if (
			request.values.should_be_running__release !== undefined &&
			affectedIds.length !== 0
		) {
			// If the device was preloaded, and then pinned, service_installs do not exist
			// for this device+release combination. We need to create these
			if (request.values.should_be_running__release != null) {
				await createReleaseServiceInstalls(api, affectedIds, {
					id: request.values.should_be_running__release,
				});
			} else {
				const devices = (await api.get({
					resource: 'device',
					options: {
						$select: ['id', 'belongs_to__application'],
						$filter: {
							id: { $in: affectedIds },
						},
					},
				})) as Array<{
					id: number;
					belongs_to__application: { __id: number };
				}>;
				const devicesByApp = _.groupBy(
					devices,
					(d) => d.belongs_to__application.__id,
				);
				await Promise.all(
					Object.keys(devicesByApp).map((appId) =>
						createAppServiceInstalls(
							api,
							devicesByApp[appId][0].belongs_to__application.__id,
							devicesByApp[appId].map((d) => d.id),
						),
					),
				);
			}
		}
	},
});

hooks.addPureHook('POST', 'resin', 'device', {
	POSTRUN: async ({ request, api, tx, result: deviceId }) => {
		// Don't try to add service installs if the device wasn't created
		if (deviceId == null) {
			return;
		}

		const rootApi = api.clone({ passthrough: { tx, req: permissions.root } });

		// Create supervisor service installs when the supervisor is pinned on device creation
		if (request.values.should_be_managed_by__release != null) {
			await createReleaseServiceInstalls(rootApi, [deviceId], {
				id: request.values.should_be_managed_by__release,
			});
		}
	},
});

hooks.addPureHook('PATCH', 'resin', 'device', {
	POSTRUN: async ({ api, request }) => {
		const affectedIds = request.affectedIds!;

		// Create supervisor service installs when the supervisor is pinned on device update
		if (
			request.values.should_be_managed_by__release != null &&
			affectedIds.length !== 0
		) {
			await createReleaseServiceInstalls(api, affectedIds, {
				id: request.values.should_be_managed_by__release,
			});
		}
	},
});
