const axios = require("axios")
const cron = require("node-cron")
const { Pool } = require("pg")
require("log-timestamp")
const mapping = require("../Node-CronJob/maps")
const dataModels = require("./dataModels")
const acesList = require("./aceList")
const stringSimilarity = require("string-similarity")
const jsonPopulacaoResidentePorAces = require("./populacaoResidentePorAces")

const pool = new Pool({
  user: "claudio",
  host: "localhost",
  database: "MDS",
  password: "postgres",
  port: 5433,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
})

let myNewObject = []

let concatToFloatList = [
  "total_utentes_sem_mdf_atribuido_por_opcao0",
  "taxa_de_utilizacao_consultas_medicas_1_ano_todos_os_utentes",
  "total_utentes_com_mdf_atribuido0",
  "total_utentes_sem_mdf_atribuido0",
  "taxa_de_utilizacao_consultas_medicas_1_ano_nos_utentes_sem_mdf",
]

function acesFixing(string) {
  return stringSimilarity.findBestMatch(string, acesList).bestMatch.target
}

function contagemNormalization(value, aces) {
  let totalPopulationAces
  let valuePer100k

  jsonPopulacaoResidentePorAces.forEach((element) => {
    if (element.aces == acesFixing(aces)) {
      totalPopulationAces = element.populacaoTotal
    }
  })

  valuePer100k = ((value / totalPopulationAces) * 100000).toFixed(2)

  return valuePer100k
}

/**
 * This function creates a new object from the recived data, and then it inserts the new freshly created object data.
 * @param {String} tableName This variable stores the table name
 * @param {JSON Object} data This variable stores a JSON with all data about the dataset called
 * @param {Object} dataModel This variable loads the Data Model correspond to the dataset called
 * @param {String} dataset This variable passes the Dataset name
 * @param {Pool} client This variable contains the database pool connection
 * @param {Integer} year This variable stores the year used on the dataset call
 */
async function executeQuery(tableName, data, dataModel, dataset, client, year) {
  try {
    data.records.forEach((element) => {
      let data = {}
      Object.keys(element.fields).forEach((field) => {
        if (field != "id") {
          if (field == "ponto_ou_localizacao_geografica" || field == "localizacao_geografica") {
            data["lat"] = element.fields[field][0]
            data["long"] = element.fields[field][1]
          } else if (field == "tempo" || field == "periodo") {
            data["tempo"] = element.fields[field] + "-01"
          } else if (field == "entidade" || field == "aces") {
            data["aces"] = acesFixing(element.fields[field])
          } else {
            if (concatToFloatList.includes(field)) {
              element.fields[field] = parseFloat(element.fields[field].replace(",", "."))
            }
            data[mapping[tableName][field]] = element.fields[field]
          }

          if (
            field != "ponto_ou_localizacao_geografica" &&
            field != "localizacao_geografica" &&
            field != "tempo" &&
            field != "periodo" &&
            field != "entidade" &&
            field != "aces" &&
            field != "regiao" &&
            field != "ars" &&
            field != "sexo"
          ) {
            data[mapping[tableName][field] + "_norm"] = mapping[tableName][field].includes("cntg")
              ? contagemNormalization(element.fields[field], element.fields[element.fields["aces"] != null ? "aces" : "entidade"])
              : element.fields[field]
          }
        }
      })
      myNewObject.push(data)
    })

    myNewObject.forEach((myNewObjectElement) => {
      const prctg = Object.keys(myNewObjectElement).filter((x) => x.includes("prctg") && x.includes("norm"))
      const cntg = Object.keys(myNewObjectElement).filter((x) => x.includes("cntg") && x.includes("norm"))

      prctg.forEach((prctgElement) => {
        let cntgMatchKeyString = stringSimilarity.findBestMatch(prctgElement, cntg).bestMatch.target
        myNewObjectElement[prctgElement] = (myNewObjectElement[prctgElement] * (myNewObjectElement[cntgMatchKeyString] / 100.0)).toFixed(2)
      })
    })

    //console.log(myNewObject)
    let datasetInsert = dataModel.insert(myNewObject).toQuery()
    await client.query(datasetInsert)
    console.log(`Status:[Atualizado]  Os dados para o indicador ${dataset} foram atualizados para o ano de ${year}`)

    myNewObject = []
  } catch (err) {
    console.log(err.stack)
  }
}
/**
 * This function verifies if the dataset table is updated, if is not, it calls the transparency API to get all present data available about the dataset
 * and then calls the function executeQuery().
 * @param {String} tableName This variable stores the table name
 * @param {String} dataset This variable passes the Dataset name
 * @param {Integer} nhits This variable stores the number of rows with data about the dataset called
 * @param {Integer} facet This variable passes the facet name to filter the dataset called by date
 * @param {Object} dataModel This variable loads the Data Model correspond to the dataset called
 * @param {Pool} client This variable contains the database pool connection
 */
async function axiosCallDataset(tableName, dataset, nhits, facet, dataModel, client) {
  try {
    let rows = 9999
    let year = new Date().getFullYear()
    let resTableRow = await client.query(`SELECT COUNT (*) FROM ${tableName};`)
    if (resTableRow.rows[0].count != nhits) {
      await client.query(`DELETE FROM ${tableName} WHERE date_part('year', tempo) = ${year};`)
      const resp = await axios.get(`https://transparencia.sns.gov.pt/api/records/1.0/search/?dataset=${dataset}&rows=${rows}&refine.${facet}=${year}`)
      return await executeQuery(tableName, resp.data, dataModel, dataset, client, year)
    } else console.log(`Status:[Normal]  Os dados para o indicador ${dataset} já se encontram atualizados`)
  } catch (err) {
    console.log(err.stack)
  }
}

/**
 * This function calls the transparency API to get the number of rows in the dataset.
 * @param {String} tableName This variable stores the table name
 * @param {String} dataset This variable passes the Dataset name
 * @param {Object} dataModel This variable loads the Data Model correspond to the dataset called
 */
async function axiosCallNhits(tableName, dataset, dataModel) {
  const client = await pool.connect()
  try {
    const resp = await axios.get(`https://transparencia.sns.gov.pt/api/records/1.0/search/?dataset=${dataset}&rows=1`)
    let facet = "tempo"
    if (resp.data.records[0].fields.periodo) {
      facet = "periodo"
    }
    await axiosCallDataset(tableName, dataset, resp.data.nhits, facet, dataModel, client)
  } catch (err) {
    console.log(err)
  } finally {
    client.release()
  }
}

/**
 * This Scheduler runs every first day of every month at 01:00h. [0 1 1 * *]
 */
cron.schedule("*/20 * * * * *", async function () {
  try {
    await axiosCallNhits("hipertensao", "hipertensao", dataModels.hipertensao)
    //await axiosCallNhits("diabetes", "diabetes", dataModels.diabetes)
    //await axiosCallNhits("saude_da_mulher_e_crianca", "saude-da-mulher-e-crianca", dataModels.saude_da_mulher_e_crianca)
    /*await axiosCallNhits("rastreios_oncologicos", "rastreios-oncologicos", dataModels.rastreios_oncologicos)
    await axiosCallNhits("registo_de_testamentos_vitais", "registo-de-testamentos-vitais", dataModels.registo_de_testamentos_vitais)
    await axiosCallNhits(
      "referenciacoes_soep_emitidas_nos_centros_de_saude",
      "referenciacoes-soep-emitidas-nos-centros-de-saude",
      dataModels.referenciacoes_soep_emitidas_nos_centros_de_saude
    )
    await axiosCallNhits(
      "utentes_inscritos_em_cuidados_de_saude_primarios",
      "utentes-inscritos-em-cuidados-de-saude-primarios",
      dataModels.utentes_inscritos_em_cuidados_de_saude_primarios
    )
    await axiosCallNhits("evolucao_do_numero_de_unidades_funcionais", "evolucao-do-numero-de-unidades-funcionais", dataModels.evolucao_do_numero_de_unidades_funcionais)
    await axiosCallNhits("evolucao_dos_contactos_de_enfermagem_nos_csp", "evolucao-dos-contactos-de-enfermagem-nos-csp", dataModels.evolucao_dos_contactos_de_enfermagem_nos_csp)
    await axiosCallNhits(
      "acesso_de_consultas_medicas_pela_populacao_inscrita",
      "acesso-de-consultas-medicas-pela-populacao-inscrita",
      dataModels.acesso_de_consultas_medicas_pela_populacao_inscrita
    )
    await axiosCallNhits("evolucao_das_consultas_medicas_nos_csp", "evolucao-das-consultas-medicas-nos-csp", dataModels.evolucao_das_consultas_medicas_nos_csp) */
  } catch (err) {
    console.log(err)
  }
})
