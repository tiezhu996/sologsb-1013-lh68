import { helper } from '@ember/component/helper';

export default helper(function join([separator, values]: [string, unknown]): string {
  return Array.isArray(values) ? values.join(separator) : '';
});
