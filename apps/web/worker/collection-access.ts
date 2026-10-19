export function validCollectionAccess(grant: {
  manage?: boolean
  readOnly: boolean
  hidePasswords: boolean
}) {
  return !grant.manage || (!grant.readOnly && !grant.hidePasswords)
}
