const text = (value) => (Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '');

/** The response contract shared by every send endpoint. Fields echo the request; `batchResults` is added after sending. */
export function mailResponse(endpoint, body, config, emailSendResponse, emailSuccess, batchResults) {
  const input = body && typeof body === 'object' ? body : {};
  const response = {
    apiEndpoint: endpoint,
    emailSender: typeof input.sender === 'string' && input.sender ? input.sender : (config.NOTIFICATION_SENDER ?? ''),
    emailReceiver: text(input.receiver ?? input.to),
    emailCC: text(input.cc),
    emailBCC: text(input.bcc),
    emailSubject: typeof input.subject === 'string' ? input.subject : '',
    emailInHtml: input.isHtml === true || input.isHtml === 'true',
    emailSendResponse,
    emailSuccess,
  };
  return batchResults ? { ...response, batchResults } : response;
}
