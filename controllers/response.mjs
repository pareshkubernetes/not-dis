const text = (value) => (Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '');

/** The response contract shared by every send endpoint. */
export function mailResponse(endpoint, body, emailSendResponse, emailSuccess) {
  const input = body && typeof body === 'object' ? body : {};
  return {
    apiEndpoint: endpoint,
    emailReceiver: text(input.receiver ?? input.to),
    emailSubject: typeof input.subject === 'string' && input.subject ? input.subject : 'No Subject',
    emailCC: text(input.cc),
    emailBCC: text(input.bcc),
    emailSendResponse,
    emailSuccess,
  };
}
