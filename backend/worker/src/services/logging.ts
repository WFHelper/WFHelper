type WorkerLogEntry = {
	type: 'request' | 'cron' | 'error' | 'admin';
	route?: string;
	method?: string;
	status?: number;
	latencyMs?: number;
	slug?: string;
	cacheHit?: boolean;
	error?: string;
};

type ResponseLogFields = Pick<WorkerLogEntry, 'cacheHit'>;

const responseLogFields = new WeakMap<Response, ResponseLogFields>();

export function annotateResponse(response: Response, fields: ResponseLogFields): Response {
	responseLogFields.set(response, {
		...responseLogFields.get(response),
		...fields,
	});
	return response;
}

export function takeResponseLogFields(response: Response): ResponseLogFields {
	const fields = responseLogFields.get(response) || {};
	responseLogFields.delete(response);
	return fields;
}

export function logEvent(entry: WorkerLogEntry): void {
	const cleanEntry: WorkerLogEntry = { type: entry.type };
	if (entry.route !== undefined) cleanEntry.route = entry.route;
	if (entry.method !== undefined) cleanEntry.method = entry.method;
	if (entry.status !== undefined) cleanEntry.status = entry.status;
	if (entry.latencyMs !== undefined) cleanEntry.latencyMs = entry.latencyMs;
	if (entry.slug !== undefined) cleanEntry.slug = entry.slug;
	if (entry.cacheHit !== undefined) cleanEntry.cacheHit = entry.cacheHit;
	if (entry.error !== undefined) cleanEntry.error = entry.error;

	console.log(cleanEntry);
}
