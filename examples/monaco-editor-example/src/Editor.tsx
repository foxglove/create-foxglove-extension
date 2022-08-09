import MonacoEditor from "@monaco-editor/react";
import { useState } from "react";

const SourceCode = `
  type MyType = {
    name: string;
    value: number;
  };

  function x() {
    const myValue: MyType = { name: "Hello", value: 1 };
    console.log(myValue);
  }
`;

/**
 * Our main editor component. For now we just wrap the MonacoEditor component.
 */
export function Editor(): JSX.Element {
  const [value, setValue] = useState<undefined | string>(SourceCode);

  return (
    <MonacoEditor
      height="100%"
      width="100%"
      theme="vs-dark"
      onChange={(newValue) => {
        setValue(newValue);
      }}
      value={value}
      defaultLanguage="typescript"
    />
  );
}
