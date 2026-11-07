/**
 * The review screen (DataViewer) tells the buttons (ActionButtons) that the number of written requests changed, so
 * "Request Changes (2)" stays right without the two components sharing state. Detail: { serviceDeliveryId, count }.
 */
export const REVIEW_REQUESTS_CHANGED_EVENT = 'td:review-requests-changed'
