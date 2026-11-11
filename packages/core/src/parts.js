// Large classes are written as parts, each in its own file: a part is a
// class whose methods are copied onto the target. A method defined twice is
// a mistake, so it throws.
export function mixParts (Target, parts) {
  for (const part of parts) {
    for (const name of Object.getOwnPropertyNames(part.prototype)) {
      if (name === 'constructor') continue
      if (name in Target.prototype) throw new Error(`${Target.name}.${name} is defined twice`)
      Object.defineProperty(Target.prototype, name, Object.getOwnPropertyDescriptor(part.prototype, name))
    }
  }
}
