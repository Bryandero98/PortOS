/**
 * Browser-side helpers for the server's hardware compatibility annotations.
 * The browser does not re-probe the host: the server owns detection, and an
 * absent annotation stays compatible for older servers and custom records.
 */

export const isHardwareCompatible = (compatibility) => compatibility?.state !== 'unavailable';

export const isHardwareAvailable = (item) => isHardwareCompatible(item?.hardwareCompatibility);

export const filterHardwareCompatibleModels = (models, { includeUnavailable = false } = {}) => {
  const list = Array.isArray(models) ? models : [];
  return includeUnavailable ? list : list.filter(isHardwareAvailable);
};
