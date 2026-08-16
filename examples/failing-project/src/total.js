// This function has a deliberate bug: it drops the last item.
// Fixing it is what turns the example from red to green.
export function total(numbers) {
  let sum = 0;
  for (let i = 0; i < numbers.length - 1; i += 1) {
    sum += numbers[i];
  }
  return sum;
}
