import { Stack, Fn } from 'aws-cdk-lib'

export const getSuffixFromStack = (stack: Stack) => {
  const shortStackId = Fn.select(2, Fn.split('/', stack.stackId))
  return Fn.select(4, Fn.split('-', shortStackId))
}
