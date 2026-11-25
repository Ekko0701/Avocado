import { appIdFromName, withName, type AppNameValue } from "../lib/app-form";

/**
 * 앱 이름 하나만 쓰면 앱 id(폴더·테스트 케이스·CLI 이름)는 이름에서 만든다. 필요할 때만 "바꾸기"로 직접 고친다.
 * 이름에 영문으로 바꿀 수 없는 글자가 있으면 처음부터 id 칸을 연다. 새 앱을 만들 때만 쓴다(등록한 앱의 id 는 바꿀 수 없다)
 */
export function AppNameField(props: { value: AppNameValue; onChange: (next: AppNameValue) => void }) {
  const { value } = props;
  const cannotDerive = value.name.trim() !== "" && appIdFromName(value.name) === "";
  const editing = value.idEdited || cannotDerive;
  return (
    <div className="app-name-field" data-testid="app-name-field">
      <label>
        이름
        <input aria-label="앱 이름" value={value.name} onChange={(e) => props.onChange(withName(value, e.target.value))} placeholder="예: Demo" />
      </label>
      {editing ? (
        <>
          <label>
            폴더·CLI 이름
            <input aria-label="앱 id" value={value.id} onChange={(e) => props.onChange({ ...value, id: e.target.value, idEdited: true })} placeholder="영문 소문자·숫자·- (예: my-app)" />
          </label>
          <small className="hint row center">
            {cannotDerive && !value.idEdited
              ? "이름에 영문이 없어 자동으로 만들지 못했습니다. 영문 소문자·숫자·하이픈으로 씁니다. 예: demo"
              : `테스트 케이스 이름(${value.id || "앱"}-TC-0001)과 터미널 명령에 씁니다. 등록한 뒤에는 바꿀 수 없습니다`}
            {value.idEdited && appIdFromName(value.name) !== "" ? (
              <button type="button" className="secondary small" onClick={() => props.onChange({ ...value, idEdited: false, id: appIdFromName(value.name) })}>
                이름에서 다시 만들기
              </button>
            ) : null}
          </small>
        </>
      ) : value.id ? (
        <small className="hint row center" data-testid="app-id-line">
          폴더·CLI 이름 <code>{value.id}</code>
          <button type="button" className="secondary small" onClick={() => props.onChange({ ...value, idEdited: true })}>
            바꾸기
          </button>
        </small>
      ) : null}
    </div>
  );
}
